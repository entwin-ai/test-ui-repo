/**
 * Google Drive Ingestion Rules — the Read Me (v1, 2026-08-01) as code.
 *
 * This module is the single, testable home for the DECISIONS the Read Me makes:
 * which file types are supported, how each decomposes into Memory Notes, when a
 * file is "large" enough to split per-page, and the cadence gate that stops a
 * file producing more than one note per day unless the user forces a refresh.
 * It contains no I/O — the pipeline (pipeline.ts) and extractors (extract.ts)
 * call into these pure functions so the rules can be reasoned about and unit
 * tested in isolation.
 *
 * Section references below point at the Read Me.
 */

// ---------------------------------------------------------------------------
// File-type classification (§3)
// ---------------------------------------------------------------------------

export type DriveFileKind =
  | 'word' // Word / Google Docs
  | 'powerpoint' // PowerPoint / Google Slides
  | 'excel' // Excel / Google Sheets  -> one note PER TAB (§3)
  | 'pdf' // PDF                     -> like Word, with carve-outs (§3)
  | 'image' // photo / screenshot / scan
  | 'video' // §3 Video — not yet supported
  | 'unsupported'

// Google Workspace native types and their binary equivalents both map to one
// kind. Native Docs/Sheets/Slides are exported to a readable MIME on download
// (see extract.ts); the KIND is the same either way.
const MIME_KIND: Record<string, DriveFileKind> = {
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/msword': 'word',
  'application/vnd.google-apps.document': 'word',
  'application/rtf': 'word',
  'text/plain': 'word',
  'text/markdown': 'word',
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'powerpoint',
  'application/vnd.ms-powerpoint': 'powerpoint',
  'application/vnd.google-apps.presentation': 'powerpoint',
  // Excel / Sheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'application/vnd.ms-excel': 'excel',
  'application/vnd.google-apps.spreadsheet': 'excel',
  'text/csv': 'excel',
  // PDF
  'application/pdf': 'pdf',
}

export function classifyMime(mimeType: string | undefined | null): DriveFileKind {
  const m = (mimeType || '').toLowerCase()
  if (MIME_KIND[m]) return MIME_KIND[m]
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  return 'unsupported'
}

/** §3 Video: parked until a vision-capable video model is identified. */
export function isSupportedForIngestion(kind: DriveFileKind): boolean {
  return kind !== 'video' && kind !== 'unsupported'
}

// ---------------------------------------------------------------------------
// Decomposition granularity (§3 Excel one-note-per-tab; §4 large-file split)
// ---------------------------------------------------------------------------

export type NoteGranularity = 'file' | 'tab' | 'page' | 'slide' | 'unreadable'

/**
 * Large-file threshold (§4). The Read Me deliberately leaves the exact number
 * as an OPEN ITEM ("judged by page count, token count, or another measure").
 * We pick page/slide count as the concrete measure (the most predictable proxy
 * for reader cost) and make it env-overridable so engineering can tune it
 * without a code change — honouring the open item rather than pretending it was
 * resolved. Below the threshold: one note per file. At or above: one note per
 * page (Word/PDF) or per slide (PowerPoint).
 */
export const LARGE_FILE_PAGE_THRESHOLD = (() => {
  const n = Number(process.env.DRIVE_LARGE_FILE_PAGE_THRESHOLD)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 40
})()

/**
 * Excel entity-extraction cap (§3). Also an OPEN ITEM ("a stated heuristic, not
 * yet a hard rule"). Above this many DISTINCT candidate entities on one tab, we
 * switch to the no-per-row-extraction treatment (like email's Marketing/Updates
 * tier): the tab still gets a note, but bulk rows don't each spawn an entity.
 */
export const EXCEL_ENTITY_SOFT_CAP = (() => {
  const n = Number(process.env.DRIVE_EXCEL_ENTITY_CAP)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 25
})()

export interface DecompositionInput {
  kind: DriveFileKind
  /** total pages (Word/PDF) or slides (PowerPoint); undefined if unknown yet */
  pageCount?: number
  /** for Excel: the tab/sheet names */
  tabNames?: string[]
  /** PDF only: whether the file is password-protected / otherwise unreadable */
  unreadable?: boolean
}

export interface DecompositionPlan {
  granularity: NoteGranularity
  /** how many notes this file will produce */
  noteCount: number
  /** true when §4's per-page split kicked in */
  isLarge: boolean
  /** for tab granularity, the tab names driving one-note-each */
  tabs?: string[]
}

/**
 * Decide how a file decomposes into notes, applying §3 (Excel per-tab, PDF
 * unreadable) and §4 (large-file per-page/per-slide). This is the one place the
 * "one note per file by default" rule and its exceptions live.
 */
export function planDecomposition(input: DecompositionInput): DecompositionPlan {
  // §3 PDF: a password-protected / unreadable PDF still produces ONE note,
  // metadata-only, no content gist. It never splits.
  if (input.unreadable) {
    return { granularity: 'unreadable', noteCount: 1, isLarge: false }
  }

  // §3 Excel/Sheets: one Memory Note PER TAB — the one file type that departs
  // from the file-level default, regardless of size.
  if (input.kind === 'excel') {
    const tabs = input.tabNames && input.tabNames.length ? input.tabNames : ['Sheet1']
    return { granularity: 'tab', noteCount: tabs.length, isLarge: false, tabs }
  }

  // §4 Large-file split for Word / PowerPoint / PDF: beyond the threshold, one
  // note per page (Word/PDF) or per slide (PowerPoint).
  if (
    (input.kind === 'word' || input.kind === 'pdf' || input.kind === 'powerpoint') &&
    typeof input.pageCount === 'number' &&
    input.pageCount >= LARGE_FILE_PAGE_THRESHOLD
  ) {
    return {
      granularity: input.kind === 'powerpoint' ? 'slide' : 'page',
      noteCount: input.pageCount,
      isLarge: true,
    }
  }

  // Default (§3): one note per file, sequential start-to-end read. Covers
  // small Word/PPT/PDF and every image.
  return { granularity: 'file', noteCount: 1, isLarge: false }
}

// ---------------------------------------------------------------------------
// Diff cadence + the once-per-day gate (§1)
// ---------------------------------------------------------------------------

export type ScanTrigger = 'first-connect' | 'daily-scan' | 'forced-refresh'

export interface FileLedgerSnapshot {
  driveModifiedTime?: string | null // ISO
  driveVersion?: string | null
  md5Checksum?: string | null
  contentHash?: string | null
  lastNoteDate?: string | null // 'YYYY-MM-DD'
}

export interface DriveFileMeta {
  modifiedTime?: string | null
  version?: string | null
  md5Checksum?: string | null
}

/**
 * Has the Drive file changed since we last ingested it? Uses whichever change
 * signals Drive gives us, most-reliable first:
 *   1. md5Checksum   — exact, but only present for binary uploads (not native
 *                      Docs/Sheets/Slides).
 *   2. version       — Drive's monotonic version string.
 *   3. modifiedTime  — last-modified timestamp.
 * A brand-new file (no ledger) always counts as changed.
 */
export function hasFileChanged(prev: FileLedgerSnapshot | null, cur: DriveFileMeta): boolean {
  if (!prev) return true
  if (cur.md5Checksum && prev.md5Checksum) return cur.md5Checksum !== prev.md5Checksum
  if (cur.version && prev.driveVersion) return cur.version !== prev.driveVersion
  if (cur.modifiedTime && prev.driveModifiedTime) {
    return new Date(cur.modifiedTime).getTime() !== new Date(prev.driveModifiedTime).getTime()
  }
  // No comparable signal on either side -> assume changed, let content_hash
  // dedupe downstream.
  return true
}

export type IngestDecision =
  | { action: 'ingest'; reason: string }
  | { action: 'skip'; reason: string }

/**
 * The §1 cadence gate. Given the trigger and the file's ledger, decide whether
 * to (re)ingest now. Encodes:
 *   • First connection: every file read in full (§1).
 *   • Ongoing daily scan: only changed files; and never more than one note per
 *     file per day — if we already wrote a note for this file today, the daily
 *     scan collapses further same-day edits into that note (skip re-emit).
 *   • Forced refresh: an out-of-cycle diff check; a change produces ITS OWN
 *     note even if one was already written today (§1 Same-day multiplicity).
 */
export function decideIngest(
  trigger: ScanTrigger,
  prev: FileLedgerSnapshot | null,
  cur: DriveFileMeta,
  today: string, // 'YYYY-MM-DD' in the user's cadence day
): IngestDecision {
  if (trigger === 'first-connect') {
    return { action: 'ingest', reason: 'first connection — full read' }
  }

  const changed = hasFileChanged(prev, cur)

  if (trigger === 'forced-refresh') {
    // A forced refresh only emits a note when there is actually a diff; a
    // forced refresh that finds no change writes nothing (§1).
    return changed
      ? { action: 'ingest', reason: 'forced refresh — diff found' }
      : { action: 'skip', reason: 'forced refresh — no diff' }
  }

  // daily-scan
  if (!changed) return { action: 'skip', reason: 'daily scan — unchanged' }
  if (prev?.lastNoteDate === today) {
    // Already produced a note today; the daily scan collapses same-day edits
    // into that one cumulative-diff note rather than emitting a second.
    return { action: 'skip', reason: 'daily scan — already noted today' }
  }
  return { action: 'ingest', reason: 'daily scan — changed since last read' }
}

/**
 * §1 Historical documents: a file that existed before Entwin was connected is
 * dated to the file's OWN last-modified date, not the ingestion day. On first
 * connection we therefore stamp the note with modifiedTime; on later diffs the
 * note is dated to the day the diff is captured (the edit's day). Returns a
 * 'YYYY-MM-DD' string.
 */
export function noteDateFor(
  trigger: ScanTrigger,
  cur: DriveFileMeta,
  today: string,
): string {
  if (trigger === 'first-connect' && cur.modifiedTime) {
    return cur.modifiedTime.slice(0, 10)
  }
  return today
}
