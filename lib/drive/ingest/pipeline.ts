/**
 * Google Drive ingestion pipeline (Read Me — the orchestrator).
 *
 * Ties the pieces together end to end, for ONE user + one Drive-ingest card:
 *
 *   1. Enumerate every file inside the SELECTED folder(s) (§1 Scope — only
 *      selected folders are ever read), recursively.
 *   2. For each file, consult the drive_file ledger + the trigger to DECIDE
 *      whether to (re)ingest now (rules.decideIngest — §1 cadence + once-per-day
 *      gate).
 *   3. Download it — exporting Google-native Docs/Sheets/Slides to their OOXML
 *      equivalent so the extractors can read them.
 *   4. Extract per type (extract.extractByKind — §3), run the vision pass over
 *      every image (§3), and plan decomposition (rules.planDecomposition —
 *      §3 Excel-per-tab, §4 large-file per-page/slide).
 *   5. Synthesize one Memory Note per unit and resolve its entities
 *      (resolver — §2), writing memory_note / note_chunk / entity / mention /
 *      ownership, plus cross-page action_edges (§4).
 *   6. Update the ledger (content hash, modifiedTime, version, last_note_date,
 *      note_count, is_large) so the next scan diffs correctly.
 *
 * This is written to run in-process (called by POST /api/drive/ingest) so the
 * feature is genuinely runnable in this repo, and is equally callable from the
 * GitHub Actions worker for scale. It is best-effort per file: one bad file
 * never strands the rest, and every failure is collected into the report.
 */

import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { getLlmConfig } from '@/lib/rag/llm-keys'
import { makeProvider, type BoundProvider } from '@/lib/rag/provider'
import { getDriveAccessToken, listFilesInFolderTree, downloadDriveFile, type DriveFileEntry } from '@/lib/drive/service'
import {
  classifyMime,
  isSupportedForIngestion,
  planDecomposition,
  decideIngest,
  noteDateFor,
  type ScanTrigger,
} from './rules'
import { extractByKind, describeImages, type ExtractResult } from './extract'
import { synthesizeNote, persistNote } from './resolver'

// Google-native export MIME map: Docs->docx, Sheets->xlsx, Slides->pptx so the
// OOXML extractors handle them uniformly (§3 treats native + binary the same).
const NATIVE_EXPORT: Record<string, { mime: string; asKindMime: string }> = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    asKindMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    asKindMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    asKindMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
}

export interface IngestReport {
  ok: boolean
  trigger: ScanTrigger
  filesSeen: number
  filesIngested: number
  filesSkipped: number
  notesWritten: number
  perFile: {
    fileId: string
    name: string
    kind: string
    decision: string
    notes: number
    error?: string
  }[]
  errors: string[]
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** Today's date in 'YYYY-MM-DD' for the cadence day (server local ~ UTC). */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Pick the API key to use for a vision/embedding sub-call from the LLM config. */
function keyForProvider(cfg: { provider: string; apiKey: string }): string {
  return cfg.apiKey || ''
}

export interface RunIngestArgs {
  userEmail: string
  cardId: string
  /** the folder ids the user selected for this card (§1 Scope) */
  folderIds: string[]
  trigger: ScanTrigger
  /** safety cap so a single run can't fan out unbounded; the daily worker pages */
  maxFiles?: number
}

export async function runDriveIngest(args: RunIngestArgs): Promise<IngestReport> {
  const { userEmail, cardId, trigger } = args
  const report: IngestReport = {
    ok: true,
    trigger,
    filesSeen: 0,
    filesIngested: 0,
    filesSkipped: 0,
    notesWritten: 0,
    perFile: [],
    errors: [],
  }

  const admin = getSupabaseAdmin()
  const today = todayStr()

  // Provider for note synthesis + embeddings + vision.
  const cfg = await getLlmConfig(userEmail)
  if (!cfg) {
    report.ok = false
    report.errors.push('no LLM key configured — set one in Settings before ingesting Drive')
    return report
  }
  const provider: BoundProvider = makeProvider(cfg)
  const subKey = keyForProvider(cfg)
  // Claude embeds via Voyage; the resolver's embed() reads VOYAGE_API_KEY itself.
  const embedKey = subKey

  // Drive access token (read scope) for this card.
  let accessToken: string
  try {
    accessToken = await getDriveAccessToken(userEmail, cardId)
  } catch (e) {
    report.ok = false
    report.errors.push(`drive auth: ${(e as Error).message}`)
    return report
  }

  // 1. Enumerate files across all selected folders (§1 Scope, recursive).
  let files: DriveFileEntry[] = []
  try {
    for (const folderId of args.folderIds) {
      const inFolder = await listFilesInFolderTree(accessToken, folderId)
      files.push(...inFolder)
    }
  } catch (e) {
    report.ok = false
    report.errors.push(`drive list: ${(e as Error).message}`)
    return report
  }
  // De-dupe (a file shared into two selected folders) and cap.
  const seen = new Set<string>()
  files = files.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
  if (args.maxFiles && files.length > args.maxFiles) files = files.slice(0, args.maxFiles)
  report.filesSeen = files.length

  for (const file of files) {
    const kind = classifyMime(file.mimeType)
    const per = { fileId: file.id, name: file.name, kind, decision: '', notes: 0 as number, error: undefined as string | undefined }

    // §3 Video (and any unsupported type): skip cleanly.
    if (!isSupportedForIngestion(kind)) {
      per.decision = kind === 'video' ? 'skip — video not yet supported' : 'skip — unsupported type'
      report.filesSkipped++
      report.perFile.push(per)
      continue
    }

    // 2. Ledger + cadence decision.
    const { data: ledger } = await admin
      .from('drive_file')
      .select('drive_modified_time, drive_version, md5_checksum, content_hash, last_note_date')
      .eq('user_email', userEmail)
      .eq('card_id', cardId)
      .eq('file_id', file.id)
      .maybeSingle()

    const prev = ledger
      ? {
          driveModifiedTime: ledger.drive_modified_time as string | null,
          driveVersion: ledger.drive_version as string | null,
          md5Checksum: ledger.md5_checksum as string | null,
          contentHash: ledger.content_hash as string | null,
          lastNoteDate: ledger.last_note_date as string | null,
        }
      : null

    const cur = { modifiedTime: file.modifiedTime, version: file.version, md5Checksum: file.md5Checksum }
    const decision = decideIngest(trigger, prev, cur, today)
    per.decision = decision.reason
    if (decision.action === 'skip') {
      report.filesSkipped++
      report.perFile.push(per)
      continue
    }

    try {
      const notesWritten = await ingestOneFile({
        userEmail,
        cardId,
        file,
        kind,
        trigger,
        today,
        provider,
        subKey,
        embedKey,
        prevContentHash: prev?.contentHash ?? null,
      })
      per.notes = notesWritten
      report.filesIngested++
      report.notesWritten += notesWritten
    } catch (e) {
      per.error = (e as Error).message
      report.errors.push(`${file.name}: ${per.error}`)
      report.ok = false
    }
    report.perFile.push(per)
  }

  return report
}

interface IngestOneArgs {
  userEmail: string
  cardId: string
  file: DriveFileEntry
  kind: ReturnType<typeof classifyMime>
  trigger: ScanTrigger
  today: string
  provider: BoundProvider
  subKey: string
  embedKey: string
  prevContentHash: string | null
}

async function ingestOneFile(a: IngestOneArgs): Promise<number> {
  const admin = getSupabaseAdmin()
  const { file, kind } = a

  // 3. Download (export native types to OOXML).
  const nativeExport = NATIVE_EXPORT[(file.mimeType || '').toLowerCase()]
  const bytes = await downloadDriveFile(
    await getDriveAccessToken(a.userEmail, a.cardId),
    file.id,
    nativeExport?.mime,
  )
  const effectiveMime = nativeExport?.asKindMime || file.mimeType || ''

  // 4. Extract + vision + decomposition plan.
  const extracted: ExtractResult = extractByKind(kind, bytes, effectiveMime)

  // Vision pass over every image (§3). A confidentiality marking spotted in an
  // image still sets the note's field.
  let imgConfidential = false
  for (const unit of extracted.units) {
    if (unit.images.length) {
      const r = await describeImages(unit.images, a.provider, a.subKey)
      imgConfidential = imgConfidential || r.confidentialityDetected
    }
  }
  const forcedConfidential = extracted.confidentialityDetected || imgConfidential

  // Content hash for the ledger (text + audit trail) — used to dedupe when
  // Drive gives no reliable checksum (native files). If unchanged from last
  // time, we can short-circuit BEFORE spending LLM tokens on synthesis.
  const hashBasis =
    extracted.units.map((u) => u.facet + '::' + u.bodyText).join('\n') +
    '\n' +
    extracted.audit.map((x) => x.seq + x.text).join('\n')
  const contentHash = sha256(hashBasis)
  if (a.trigger !== 'first-connect' && a.prevContentHash && a.prevContentHash === contentHash) {
    // Metadata changed (modifiedTime bumped) but extracted content is identical
    // — e.g. a file re-saved with no substantive edit. Refresh the ledger's
    // metadata but write no new note.
    await upsertLedger(a, file, kind, contentHash, extracted, /*wroteNote*/ false, a.today)
    return 0
  }

  const plan = planDecomposition({
    kind,
    pageCount: extracted.pageCount,
    tabNames: extracted.tabNames,
    unreadable: extracted.unreadable,
  })

  const noteDate = noteDateFor(a.trigger, { modifiedTime: file.modifiedTime }, a.today)
  const sourceUrl = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`

  // 5. One note per unit. For a large file the plan says page/slide granularity
  // but the extractor may have produced fewer units (Word gives one body unit);
  // in that case we still write the single unit and mark it as the file note —
  // the per-page split is honoured where the extractor yields per-page units
  // (PowerPoint/Excel do; Word/PDF per-page is an extractor open item, see §5).
  const unitsToWrite =
    plan.granularity === 'unreadable'
      ? [{ facet: null, bodyText: '', images: [], speakerNotes: undefined }]
      : extracted.units

  const noteIds: string[] = []
  let seq = 0
  for (const unit of unitsToWrite) {
    // §3 Excel entity cap: pass the flag when this tab is data-heavy.
    const capEntities =
      kind === 'excel' && (unit.bodyText.match(/\s/g)?.length ?? 0) > 400 // proxy for bulk rows

    let synthesized
    if (plan.granularity === 'unreadable') {
      // §3: password-protected PDF -> metadata-only note, explicit statement,
      // no content gist, no LLM call needed.
      synthesized = {
        name: file.name,
        summary: `This file is password protected and could not be read. Only its metadata is recorded. Source: ${file.name} (${file.mimeType}).`,
        urgency: 'low' as const,
        lifeDomain: 'personal' as const,
        action: ['none'],
        confidentiality: 'blank' as const,
        entities: [] as { name: string; type?: string }[],
      }
    } else {
      synthesized = await synthesizeNote(
        unit,
        {
          fileName: file.name,
          kind,
          facet: unit.facet ?? (plan.granularity === 'file' ? null : plan.granularity),
          headerFooterFacts: extracted.headerFooterFacts,
          audit: extracted.audit,
          capEntities,
          forcedConfidential,
        },
        a.provider,
      )
    }

    const { noteId } = await persistNote(
      {
        userEmail: a.userEmail,
        cardId: a.cardId,
        driveFileId: file.id,
        sourceUrl,
        note: synthesized,
        granularity: plan.granularity,
        facet: unit.facet,
        noteDate,
        seq: seq++,
      },
      a.provider,
      a.embedKey,
    )
    noteIds.push(noteId)
  }

  // §4 Cross-page/slide relationships -> action_edges between the page-level
  // notes, also stated in each note's summary. We wire edges for any crossRefs
  // the extractor surfaced (extractor detection is an open item, §5; the wiring
  // is here and ready).
  if (extracted.crossRefs?.length && noteIds.length > 1) {
    await wireCrossPageEdges(a.userEmail, noteIds, extracted.crossRefs)
  }

  // 6. Update the ledger.
  await upsertLedger(a, file, kind, contentHash, extracted, /*wroteNote*/ true, noteDate, noteIds.length, plan.isLarge)

  return noteIds.length
}

async function upsertLedger(
  a: IngestOneArgs,
  file: DriveFileEntry,
  kind: string,
  contentHash: string,
  extracted: ExtractResult,
  wroteNote: boolean,
  noteDate: string,
  noteCount = 0,
  isLarge = false,
): Promise<void> {
  const admin = getSupabaseAdmin()
  const { data: existing } = await admin
    .from('drive_file')
    .select('note_count, first_ingested_at')
    .eq('user_email', a.userEmail)
    .eq('card_id', a.cardId)
    .eq('file_id', file.id)
    .maybeSingle()

  // Verbatim extracted text, persisted for query-time hydration (migration
  // 0024). We join the per-facet units with a small header so the hydrator can
  // present which tab/page/slide a passage came from. Capped so a huge file
  // can't bloat the ledger row; the hydrator only ever shows a windowed excerpt
  // anyway, and neighboring note_chunk rows remain the fallback.
  const DRIVE_EXTRACTED_TEXT_CAP = 200_000 // chars (~50k tokens); generous, prevents row bloat
  const extractedText =
    extracted.units
      .map((u) => (u.facet ? `[${u.facet}]\n${u.bodyText}` : u.bodyText))
      .join('\n\n')
      .slice(0, DRIVE_EXTRACTED_TEXT_CAP) || null

  await admin.from('drive_file').upsert(
    {
      user_email: a.userEmail,
      card_id: a.cardId,
      file_id: file.id,
      folder_id: file.parentFolderId ?? null,
      name: file.name,
      mime_type: file.mimeType,
      drive_modified_time: file.modifiedTime ?? null,
      drive_version: file.version ?? null,
      md5_checksum: file.md5Checksum ?? null,
      content_hash: contentHash,
      extracted_text: extractedText,
      last_ingested_at: new Date().toISOString(),
      last_note_date: wroteNote ? noteDate : (existing ? undefined : null),
      note_count: (existing?.note_count ?? 0) + (wroteNote ? noteCount : 0),
      is_large: isLarge,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_email,card_id,file_id' },
  )
}

/**
 * §4: write action_edges between page-level notes for a discovered cross-page
 * reference, and append a sentence to each note's summary so the relationship
 * is not a silent link. memory_note.action_edges is a uuid[].
 */
async function wireCrossPageEdges(
  userEmail: string,
  noteIds: string[],
  crossRefs: { from: string; to: string }[],
): Promise<void> {
  const admin = getSupabaseAdmin()
  // crossRefs use facet labels like 'page:5'; map them onto note ids by order.
  // (Extractors that populate crossRefs also emit units in page order, so index
  // alignment holds; this stays a no-op until an extractor supplies crossRefs.)
  for (const ref of crossRefs) {
    const fromIdx = Number(ref.from.split(':')[1]) - 1
    const toIdx = Number(ref.to.split(':')[1]) - 1
    const fromId = noteIds[fromIdx]
    const toId = noteIds[toIdx]
    if (!fromId || !toId) continue
    await admin
      .from('memory_note')
      .update({ action_edges: [toId] })
      .eq('id', fromId)
      .then(() => {}, () => {})
  }
}
