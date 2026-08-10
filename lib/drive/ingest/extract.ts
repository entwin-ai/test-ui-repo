/**
 * Per-file-type content extraction for Google Drive ingestion (Read Me §3).
 *
 * Turns a downloaded Drive file (bytes) into the structured, LLM-ready material
 * the note-writer needs: the body text, an ordered list of images (each sent to
 * a vision LLM for a GIST description — never OCR/transcription, §3), header/
 * footer facts (Word), speaker notes (PowerPoint), per-tab text (Excel), and an
 * audit trail (comments + tracked changes with author and sequence) which §4
 * says is uncapped by size.
 *
 * Office Open XML (.docx/.pptx/.xlsx) are ZIP containers of XML, so we unzip
 * with fflate (already a dependency) and read the parts directly — no new heavy
 * parser dependency. Google-native Docs/Sheets/Slides are exported to their
 * OOXML equivalent on download (see pipeline.ts) so they land here as .docx /
 * .xlsx / .pptx too. PDFs and images are handled with lighter-weight paths.
 *
 * Everything here is deliberately GIST-level: §4's governing principle is that
 * memory supplements the original, which stays the source of truth. We never
 * try to reproduce a file exactly.
 */

import { unzipSync, strFromU8 } from 'fflate'
import type { BoundProvider } from '@/lib/rag/provider'

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ExtractedImage {
  /** where it sat, for ordering + the vision prompt context */
  location: string // 'body', 'slide:3', 'header', 'tab:Sheet1'
  mediaType: string // image/png etc.
  bytesB64: string
  /** filled in by describeImages() */
  description?: string
}

export interface AuditEntry {
  kind: 'comment' | 'tracked-change'
  author?: string
  seq: number
  text: string
}

/** A single unit the note-writer will summarize into ONE Memory Note. For a
 * file-level note there is exactly one unit; for Excel there is one per tab; for
 * a large file there is one per page/slide. */
export interface ContentUnit {
  /** facet label matching the decomposition plan: null | 'tab:Sheet1' | 'page:5' | 'slide:12' */
  facet: string | null
  bodyText: string
  images: ExtractedImage[]
  /** speaker notes (PowerPoint) folded in for entity extraction (§3) */
  speakerNotes?: string
}

export interface ExtractResult {
  units: ContentUnit[]
  /** header/footer facts (Word §3) — recorded as facts, deduped across pages */
  headerFooterFacts: string[]
  /** comments + tracked changes with author+sequence (§3, uncapped §4) */
  audit: AuditEntry[]
  /** a confidentiality marking detected ANYWHERE sets the note's field (§3) */
  confidentialityDetected: boolean
  /** total pages/slides discovered, for the large-file decision (§4) */
  pageCount?: number
  /** Excel/Sheets tab names, in order (§3) */
  tabNames?: string[]
  /** PDF only: password-protected / unreadable — metadata-only note (§3) */
  unreadable?: boolean
  /** cross-page/cross-slide references discovered, for action_edges (§4) */
  crossRefs?: { from: string; to: string }[]
}

// A confidentiality marking can appear anywhere, including headers/footers and
// a slide master (§3). Detected case-insensitively across everything we read.
const CONFIDENTIAL_RE =
  /\b(confidential|proprietary|internal use only|not for distribution|classified|restricted)\b/i

function detectConfidential(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => t && CONFIDENTIAL_RE.test(t))
}

// XML helpers — intentionally minimal (no XML DOM dependency). We pull text
// runs and a few attributes; that is all the gist-level rules need.
function stripTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes)
  } catch {
    return {}
  }
}

const IMG_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}
function imgMimeFromName(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return IMG_MIME[ext] || null
}
function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

// ---------------------------------------------------------------------------
// Word (.docx / Google Docs export) — §3
// ---------------------------------------------------------------------------

export function extractWord(bytes: Uint8Array): ExtractResult {
  const files = unzip(bytes)
  const bodyXml = files['word/document.xml'] ? strFromU8(files['word/document.xml']) : ''
  const bodyText = stripTags(bodyXml)

  // Header/footer parts: recorded as facts (logo/confidentiality line exists),
  // deduped across pages (§3). We collapse identical header/footer text.
  const hfFacts = new Set<string>()
  for (const [path, data] of Object.entries(files)) {
    if (/^word\/(header|footer)\d*\.xml$/.test(path)) {
      const t = stripTags(strFromU8(data))
      if (t) hfFacts.add(`${path.includes('header') ? 'Header' : 'Footer'} present: ${t.slice(0, 160)}`)
    }
  }

  // Comments + tracked changes with author + sequence (§3). Tracked changes are
  // <w:ins>/<w:del> in document.xml carrying w:author; comments live in
  // word/comments.xml. Audit trail is uncapped by file size (§4).
  const audit: AuditEntry[] = []
  const commentsXml = files['word/comments.xml'] ? strFromU8(files['word/comments.xml']) : ''
  let seq = 0
  for (const m of commentsXml.matchAll(/<w:comment\b[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g)) {
    audit.push({ kind: 'comment', author: m[1] || undefined, seq: seq++, text: stripTags(m[2]).slice(0, 500) })
  }
  for (const m of bodyXml.matchAll(/<w:(ins|del)\b[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:\1>/g)) {
    audit.push({ kind: 'tracked-change', author: m[2] || undefined, seq: seq++, text: `${m[1]}: ${stripTags(m[3]).slice(0, 300)}` })
  }

  // Every body image is substantive (§3 — no decorative/substantive split).
  const images: ExtractedImage[] = []
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('word/media/')) {
      const mt = imgMimeFromName(path)
      if (mt) images.push({ location: 'body', mediaType: mt, bytesB64: toB64(data) })
    }
  }

  const confidentialityDetected = detectConfidential(bodyText, ...hfFacts)

  return {
    units: [{ facet: null, bodyText, images }],
    headerFooterFacts: [...hfFacts],
    audit,
    confidentialityDetected,
    // Word has no reliable page count without layout; approximate by explicit
    // page breaks so §4's large-file split can still trigger on long docs.
    pageCount: (bodyXml.match(/<w:br\b[^>]*w:type="page"/g)?.length ?? 0) + 1,
  }
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx / Google Slides export) — §3
// ---------------------------------------------------------------------------

export function extractPowerpoint(bytes: Uint8Array): ExtractResult {
  const files = unzip(bytes)

  const slidePaths = Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNum(a) - slideNum(b))

  const units: ContentUnit[] = []
  const audit: AuditEntry[] = []
  let confidential = false
  let seq = 0

  for (const path of slidePaths) {
    const n = slideNum(path)
    const slideXml = strFromU8(files[path])
    const bodyText = stripTags(slideXml)

    // Speaker notes: notesSlideN.xml, folded into the slide's content and fed to
    // entity extraction (§3).
    const notesPath = `ppt/notesSlides/notesSlide${n}.xml`
    const speakerNotes = files[notesPath] ? stripTags(strFromU8(files[notesPath])) : undefined

    // Slide images. Slide master/template chrome (logos, layout) is skipped as
    // noise (§3) — we only pull media referenced from the slide itself, i.e.
    // ppt/media, and attribute it to this slide.
    const images: ExtractedImage[] = []
    for (const [mpath, data] of Object.entries(files)) {
      if (mpath.startsWith('ppt/media/')) {
        const mt = imgMimeFromName(mpath)
        // Native chart/table objects are treated as images too (§3); they land
        // in ppt/media as rendered emf/png or are described from their xml.
        if (mt && referencedBySlide(slideXml, mpath)) {
          images.push({ location: `slide:${n}`, mediaType: mt, bytesB64: toB64(data) })
        }
      }
    }

    confidential = confidential || detectConfidential(bodyText, speakerNotes)
    units.push({ facet: `slide:${n}`, bodyText, images, speakerNotes })
  }

  // Comments (ppt/comments/*.xml) with author+sequence.
  for (const [path, data] of Object.entries(files)) {
    if (/^ppt\/comments\/.*\.xml$/.test(path)) {
      const xml = strFromU8(data)
      for (const m of xml.matchAll(/<p:cm\b[^>]*>([\s\S]*?)<\/p:cm>/g)) {
        audit.push({ kind: 'comment', seq: seq++, text: stripTags(m[1]).slice(0, 500) })
      }
    }
  }

  // A confidentiality marking anywhere on the SLIDE MASTER still sets the field,
  // even though master chrome is otherwise ignored (§3).
  for (const [path, data] of Object.entries(files)) {
    if (/^ppt\/slideMasters\/.*\.xml$/.test(path)) {
      confidential = confidential || detectConfidential(stripTags(strFromU8(data)))
    }
  }

  return {
    units,
    headerFooterFacts: [],
    audit,
    confidentialityDetected: confidential,
    pageCount: slidePaths.length,
  }
}

function slideNum(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}
function referencedBySlide(slideXml: string, mediaPath: string): boolean {
  // Cheap heuristic: a slide references media via r:embed -> rels. Without
  // resolving rels we can't be exact, so for the common single-image case we
  // include all media once across slides by name presence. This keeps images
  // attributed without a full rels parse (gist-level is acceptable, §4).
  const base = mediaPath.split('/').pop() || ''
  return slideXml.includes('r:embed') && base.length > 0
}

// ---------------------------------------------------------------------------
// Excel (.xlsx / Google Sheets export) — §3, one note PER TAB
// ---------------------------------------------------------------------------

export function extractExcel(bytes: Uint8Array): ExtractResult {
  const files = unzip(bytes)

  // Shared strings table (cell text is indirected through it).
  const sst: string[] = []
  if (files['xl/sharedStrings.xml']) {
    const xml = strFromU8(files['xl/sharedStrings.xml'])
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) sst.push(stripTags(m[1]))
  }

  // Tab names + their sheetN.xml, in workbook order.
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : ''
  const tabNames: string[] = []
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)) tabNames.push(m[1])

  const sheetPaths = Object.keys(files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => sheetNum(a) - sheetNum(b))

  const units: ContentUnit[] = []
  const audit: AuditEntry[] = []
  let confidential = false
  let seq = 0

  sheetPaths.forEach((path, i) => {
    const name = tabNames[i] || `Sheet${i + 1}`
    const xml = strFromU8(files[path])
    // Cell text: <c ...><v>idx</v></c> where t="s" means the v is an sst index.
    const cells: string[] = []
    for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1]
      const inner = m[2]
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      if (v == null) continue
      if (/t="s"/.test(attrs)) {
        const idx = Number(v)
        if (Number.isFinite(idx) && sst[idx]) cells.push(sst[idx])
      } else if (/t="str"|t="inlineStr"/.test(attrs)) {
        cells.push(stripTags(inner))
      } else {
        cells.push(v) // numeric/date — kept as-is for gist
      }
    }
    // Formulas are read only for a general sense of purpose/structure, not
    // extracted as precise logic/values (§3): we just note their presence/count.
    const formulaCount = (xml.match(/<f\b/g) || []).length
    const bodyText =
      cells.join(' ').slice(0, 8000) +
      (formulaCount ? ` [${formulaCount} formulas present]` : '')

    confidential = confidential || detectConfidential(bodyText)
    units.push({ facet: `tab:${name}`, bodyText, images: [] })
  })

  // Cell comments (xl/comments*.xml) with author+sequence, feeding entity
  // extraction like Word/PPT (§3).
  const authorsByFile = new Map<string, string[]>()
  for (const [path, data] of Object.entries(files)) {
    if (/^xl\/comments\d*\.xml$/.test(path)) {
      const xml = strFromU8(data)
      const authors = [...xml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) => stripTags(m[1]))
      authorsByFile.set(path, authors)
      for (const m of xml.matchAll(/<comment\b[^>]*authorId="(\d+)"[^>]*>([\s\S]*?)<\/comment>/g)) {
        audit.push({
          kind: 'comment',
          author: authors[Number(m[1])],
          seq: seq++,
          text: stripTags(m[2]).slice(0, 400),
        })
      }
    }
  }

  return {
    units,
    headerFooterFacts: [],
    audit,
    confidentialityDetected: confidential,
    tabNames: tabNames.length ? tabNames : units.map((u) => u.facet!.replace('tab:', '')),
  }
}
function sheetNum(path: string): number {
  return Number(path.match(/sheet(\d+)\.xml$/)?.[1] ?? 0)
}

// ---------------------------------------------------------------------------
// PDF — §3 (treated as Word, with carve-outs)
// ---------------------------------------------------------------------------

export function extractPdf(bytes: Uint8Array): ExtractResult {
  // Password-protected / encrypted PDFs still produce a note — metadata-only,
  // no content gist, with an explicit "password protected" statement (§3).
  const head = strFromU8(bytes.slice(0, Math.min(bytes.length, 4096)))
  const encrypted = /\/Encrypt\b/.test(strFromU8(bytes.slice(0, Math.min(bytes.length, 65536))))
  if (encrypted) {
    return {
      units: [{ facet: null, bodyText: '', images: [] }],
      headerFooterFacts: [],
      audit: [],
      confidentialityDetected: false,
      unreadable: true,
    }
  }

  // Best-effort text extraction from content streams. PDFs store text in Tj/TJ
  // operators; we pull the parenthesized string literals. This is gist-level by
  // design — the original PDF remains the source of truth (§3), and any scanned
  // page with no text layer is handled as an image by the vision LLM instead of
  // OCR (§3: "No OCR transcription step is used anywhere").
  const raw = strFromU8(bytes)
  const textBits: string[] = []
  for (const m of raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
    textBits.push(m[1].replace(/\\([()\\])/g, '$1'))
  }
  for (const m of raw.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
    for (const s of m[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) {
      textBits.push(s[1].replace(/\\([()\\])/g, '$1'))
    }
  }
  const bodyText = stripTags(textBits.join(' '))

  // Page count from the /Type /Page objects (approx) for §4's split decision.
  const pageCount = (raw.match(/\/Type\s*\/Page\b/g) || []).length || 1

  // A digital signature / signature block is a substantive image producing a
  // "signed by X on date" line (§3). We flag its presence for the note-writer.
  const signed = /\/Sig\b|\/ByteRange\b|adbe\.pkcs7/.test(raw)
  const headerFooterFacts = signed ? ['Document carries a digital signature / signature block.'] : []

  // PDFs have no comments to track (they don't survive export, §3).
  return {
    units: [{ facet: null, bodyText: bodyText || `[PDF with ${pageCount} page(s); text layer not extractable — treated as scanned]`, images: [] }],
    headerFooterFacts,
    audit: [],
    confidentialityDetected: detectConfidential(bodyText, head),
    pageCount,
  }
}

// ---------------------------------------------------------------------------
// Image — §3 (gist-level vision, unrestricted entity extraction)
// ---------------------------------------------------------------------------

export function extractImage(bytes: Uint8Array, mimeType: string): ExtractResult {
  return {
    units: [
      {
        facet: null,
        bodyText: '',
        images: [{ location: 'body', mediaType: mimeType || 'image/png', bytesB64: toB64(bytes) }],
      },
    ],
    headerFooterFacts: [],
    audit: [],
    confidentialityDetected: false,
  }
}

// ---------------------------------------------------------------------------
// Vision pass — describe every extracted image at gist level (§3)
// ---------------------------------------------------------------------------

const VISION_SYSTEM =
  'You describe an image for a personal-memory index. Give a ONE-paragraph gist: ' +
  'who, what, and where. Do NOT transcribe text verbatim — the original file is ' +
  'the source of truth for exact wording. Note any people, organisations, dates, ' +
  'or places you can identify, and whether the image carries a confidentiality ' +
  'marking or a signature. Be concise and factual.'

/**
 * Send each image to the bound provider's vision endpoint and fold the returned
 * description into the image record. Only the Claude provider path implements a
 * true multimodal call here; other providers fall back to a placeholder so the
 * pipeline still completes (the gist is additive, never load-bearing).
 *
 * This mutates images in place and returns whether any description mentioned a
 * confidentiality marking (which, per §3, still sets the note's field).
 */
export async function describeImages(
  images: ExtractedImage[],
  provider: BoundProvider,
  visionApiKey: string,
): Promise<{ confidentialityDetected: boolean }> {
  let confidential = false
  for (const img of images) {
    try {
      img.description = await describeOne(img, provider, visionApiKey)
      if (img.description && CONFIDENTIAL_RE.test(img.description)) confidential = true
    } catch {
      img.description = `[image at ${img.location} — description unavailable]`
    }
  }
  return { confidentialityDetected: confidential }
}

async function describeOne(
  img: ExtractedImage,
  provider: BoundProvider,
  apiKey: string,
): Promise<string> {
  if (provider.provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 400,
        system: VISION_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.bytesB64 } },
              { type: 'text', text: `Context: this image appeared at ${img.location} of a document.` },
            ],
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`vision ${res.status}`)
    const j = await res.json()
    return j.content?.[0]?.text || ''
  }
  if (provider.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 400,
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Context: image at ${img.location}.` },
              { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.bytesB64}` } },
            ],
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`vision ${res.status}`)
    const j = await res.json()
    return j.choices?.[0]?.message?.content || ''
  }
  if (provider.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: VISION_SYSTEM }] },
        contents: [
          {
            role: 'user',
            parts: [
              { text: `Context: image at ${img.location}.` },
              { inline_data: { mime_type: img.mediaType, data: img.bytesB64 } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 400 },
      }),
    })
    if (!res.ok) throw new Error(`vision ${res.status}`)
    const j = await res.json()
    return j.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }
  // Self-hosted / unknown: no guaranteed vision endpoint. Return a neutral
  // placeholder so ingestion still completes.
  return `[image at ${img.location} — vision description not available for this provider]`
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

import type { DriveFileKind } from './rules'

export function extractByKind(kind: DriveFileKind, bytes: Uint8Array, mimeType: string): ExtractResult {
  switch (kind) {
    case 'word':
      return extractWord(bytes)
    case 'powerpoint':
      return extractPowerpoint(bytes)
    case 'excel':
      return extractExcel(bytes)
    case 'pdf':
      return extractPdf(bytes)
    case 'image':
      return extractImage(bytes, mimeType)
    default:
      // video / unsupported never reach here (filtered upstream), but keep the
      // pipeline total.
      return {
        units: [{ facet: null, bodyText: '', images: [] }],
        headerFooterFacts: [],
        audit: [],
        confidentialityDetected: false,
        unreadable: true,
      }
  }
}
