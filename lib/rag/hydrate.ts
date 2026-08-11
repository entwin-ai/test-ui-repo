import { getSupabaseAdmin } from './supabase'

/**
 * Raw-source hydration.
 *
 * RAG retrieves over the DISTILLED memory note (raw_summary -> note_chunk ->
 * embedding). That's great for relevance but the model only ever sees the
 * compressed summary, so it can't elaborate with the specifics of the original
 * message / email / document. Hydration closes that gap: after retrieval, for
 * the top-K matched notes we follow memory_note's back-pointer to the raw
 * source and attach a VERBATIM excerpt to that note's context block, so the
 * model can quote and elaborate on what was actually said.
 *
 * The same helper backs "memory mapping" evidence: given a note_id from an
 * entity_mention, resolve the raw source row so the map can show the actual
 * message behind an entity or an edge.
 *
 * Four sources, three strategies:
 *   - WhatsApp / Slack (conversational): follow the FK to the raw ledger row,
 *     then pull a ±5-message window in the same conversation (reconstructs the
 *     exchange).
 *   - Email: follow the FK to email_message, use clean_body (subject + sender
 *     give framing the summary drops). No windowing — one email body is plenty.
 *   - Drive: pull drive_file.extracted_text (migration 0024). For rows ingested
 *     before that column existed (extracted_text null), fall back to pulling
 *     neighboring note_chunk rows for the same file so the model still sees the
 *     surrounding passage.
 *
 * ISOLATION: every query below carries user_email in its WHERE clause. We NEVER
 * trust a conversation id / file id read off a note without re-scoping by the
 * caller's user_email — the note row itself was already fetched under that
 * scope, but the follow-on ledger reads re-assert it defensively.
 */

// Per-source knobs.
const CONVO_WINDOW = 5 // ±5 messages around a matched WhatsApp/Slack message
const CONVO_BODY_CAP = 400 // chars per conversational message line
const EMAIL_BODY_CAP = 2_000 // chars of an email body
const DRIVE_TEXT_CAP = 2_500 // chars of drive extracted text / joined chunks
const DRIVE_CHUNK_NEIGHBORS = 1 // ± chunks when falling back to note_chunk

export interface HydratedNote {
  noteId: string
  source: string // 'email' | 'whatsapp' | 'slack' | 'drive'
  excerpt: string | null // verbatim raw-source text, or null if none available
}

/** Minimal note metadata the hydrator needs to dispatch per source. */
interface NoteMeta {
  id: string
  user_email: string
  source: string
  gmail_msg_id: string | null
  wa_message_id: string | null
  slack_message_id: string | null
  drive_file_id: string | null
  drive_facet: string | null
  card_id: string
}

/**
 * Hydrate a set of matched notes with verbatim source excerpts. `userEmail` is
 * the hard isolation scope; only notes belonging to that user are touched.
 * Returns a map keyed by note_id (only entries that produced an excerpt or were
 * asked for). Best-effort: a source that errors is skipped, never throws the
 * whole answer.
 */
export async function hydrateNotes(
  userEmail: string,
  noteIds: string[],
): Promise<Map<string, HydratedNote>> {
  const out = new Map<string, HydratedNote>()
  const uniq = [...new Set(noteIds)].filter(Boolean)
  if (uniq.length === 0) return out

  const admin = getSupabaseAdmin()

  // 1. Fetch note metadata for dispatch — user-scoped.
  const { data: notes, error } = await admin
    .from('memory_note')
    .select(
      'id, user_email, source, gmail_msg_id, wa_message_id, slack_message_id, drive_file_id, drive_facet, card_id',
    )
    .eq('user_email', userEmail) // HARD scope
    .in('id', uniq)
  if (error || !notes) return out

  // 2. Group by source so each strategy runs as one batched pass.
  const bySource: Record<string, NoteMeta[]> = {}
  for (const n of notes as NoteMeta[]) {
    ;(bySource[n.source] ??= []).push(n)
  }

  await Promise.all([
    hydrateConversational(userEmail, bySource['whatsapp'] ?? [], 'whatsapp', out),
    hydrateConversational(userEmail, bySource['slack'] ?? [], 'slack', out),
    hydrateEmail(userEmail, bySource['email'] ?? [], out),
    hydrateDrive(userEmail, bySource['drive'] ?? [], out),
  ])

  return out
}

// ---------------------------------------------------------------------------
// WhatsApp + Slack — identical shape, parameterized by table + conversation col.
// ---------------------------------------------------------------------------
async function hydrateConversational(
  userEmail: string,
  notes: NoteMeta[],
  source: 'whatsapp' | 'slack',
  out: Map<string, HydratedNote>,
): Promise<void> {
  if (notes.length === 0) return
  const admin = getSupabaseAdmin()

  const table = source === 'whatsapp' ? 'whatsapp_message' : 'slack_message'
  const fkCol = source === 'whatsapp' ? 'wa_message_id' : 'slack_message_id'
  const convoCol = source === 'whatsapp' ? 'chat_id' : 'channel_id'

  // Map each note to its raw message id via the FK column.
  const msgIds = notes.map((n) => (n as any)[fkCol]).filter(Boolean) as string[]
  if (msgIds.length === 0) return

  // Fetch the anchor rows (the exact messages the matched notes came from).
  const { data: anchors, error } = await admin
    .from(table)
    .select(`id, ${convoCol}, msg_timestamp`)
    .eq('user_email', userEmail) // HARD scope
    .in('id', msgIds)
  if (error || !anchors) return

  const anchorById = new Map<string, any>()
  for (const a of anchors as any[]) anchorById.set(a.id, a)

  // For each anchor, pull a ±CONVO_WINDOW window in the same conversation.
  await Promise.all(
    notes.map(async (note) => {
      const msgId = (note as any)[fkCol] as string | null
      if (!msgId) return
      const anchor = anchorById.get(msgId)
      if (!anchor) return

      const convoId = anchor[convoCol]
      const ts = anchor.msg_timestamp

      // Window = CONVO_WINDOW before (desc, then reversed) + anchor & after (asc).
      const [beforeRes, afterRes] = await Promise.all([
        admin
          .from(table)
          .select('sender_name, from_me, msg_timestamp, body')
          .eq('user_email', userEmail) // HARD scope
          .eq(convoCol, convoId)
          .lt('msg_timestamp', ts)
          .order('msg_timestamp', { ascending: false })
          .limit(CONVO_WINDOW),
        admin
          .from(table)
          .select('sender_name, from_me, msg_timestamp, body')
          .eq('user_email', userEmail) // HARD scope
          .eq(convoCol, convoId)
          .gte('msg_timestamp', ts)
          .order('msg_timestamp', { ascending: true })
          .limit(CONVO_WINDOW + 1), // +1 to include the anchor itself
      ])

      const before = (beforeRes.data ?? []).reverse()
      const after = afterRes.data ?? []
      const window = [...before, ...after]
      if (window.length === 0) return

      const lines = window.map((m: any) => {
        const who = m.from_me ? 'You' : m.sender_name || 'Them'
        const body = (m.body || '').replace(/\s+/g, ' ').trim().slice(0, CONVO_BODY_CAP)
        return `${who}: ${body}`
      })

      out.set(note.id, {
        noteId: note.id,
        source,
        excerpt: lines.join('\n'),
      })
    }),
  )
}

// ---------------------------------------------------------------------------
// Email — one clean_body per matched note, with subject/sender framing.
// ---------------------------------------------------------------------------
async function hydrateEmail(
  userEmail: string,
  notes: NoteMeta[],
  out: Map<string, HydratedNote>,
): Promise<void> {
  if (notes.length === 0) return
  const admin = getSupabaseAdmin()

  const gmailIds = notes.map((n) => n.gmail_msg_id).filter(Boolean) as string[]
  if (gmailIds.length === 0) return

  const { data: msgs, error } = await admin
    .from('email_message')
    .select('gmail_msg_id, subject, sender, clean_body')
    .eq('user_email', userEmail) // HARD scope
    .in('gmail_msg_id', gmailIds)
  if (error || !msgs) return

  const byGmailId = new Map<string, any>()
  for (const m of msgs as any[]) byGmailId.set(m.gmail_msg_id, m)

  for (const note of notes) {
    if (!note.gmail_msg_id) continue
    const m = byGmailId.get(note.gmail_msg_id)
    if (!m) continue
    const body = (m.clean_body || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, EMAIL_BODY_CAP)
    if (!body && !m.subject) continue
    const header = [m.subject ? `Subject: ${m.subject}` : null, m.sender ? `From: ${m.sender}` : null]
      .filter(Boolean)
      .join('\n')
    out.set(note.id, {
      noteId: note.id,
      source: 'email',
      excerpt: [header, body].filter(Boolean).join('\n\n') || null,
    })
  }
}

// ---------------------------------------------------------------------------
// Drive — extracted_text (0024) if present, else neighboring note_chunk rows.
// ---------------------------------------------------------------------------
async function hydrateDrive(
  userEmail: string,
  notes: NoteMeta[],
  out: Map<string, HydratedNote>,
): Promise<void> {
  if (notes.length === 0) return
  const admin = getSupabaseAdmin()

  const fileIds = notes.map((n) => n.drive_file_id).filter(Boolean) as string[]
  if (fileIds.length === 0) return

  const { data: files } = await admin
    .from('drive_file')
    .select('file_id, name, extracted_text')
    .eq('user_email', userEmail) // HARD scope
    .in('file_id', fileIds)

  const byFileId = new Map<string, any>()
  for (const f of (files ?? []) as any[]) byFileId.set(f.file_id, f)

  await Promise.all(
    notes.map(async (note) => {
      if (!note.drive_file_id) return
      const f = byFileId.get(note.drive_file_id)

      // Preferred path: verbatim extracted text captured at ingest (0024+).
      if (f?.extracted_text) {
        const label = f.name ? `Document: ${f.name}${note.drive_facet ? ` (${note.drive_facet})` : ''}` : null
        const text = String(f.extracted_text).trim().slice(0, DRIVE_TEXT_CAP)
        out.set(note.id, {
          noteId: note.id,
          source: 'drive',
          excerpt: [label, text].filter(Boolean).join('\n\n') || null,
        })
        return
      }

      // Fallback for pre-0024 rows: stitch neighboring note_chunk rows for the
      // same file so the model still sees surrounding document context.
      const { data: chunks } = await admin
        .from('note_chunk')
        .select('content, chunk_index, note_id, memory_note!inner(drive_file_id)')
        .eq('user_email', userEmail) // HARD scope
        .eq('memory_note.drive_file_id', note.drive_file_id)
        .order('chunk_index', { ascending: true })
        .limit(2 * DRIVE_CHUNK_NEIGHBORS + 3)
      if (!chunks || chunks.length === 0) return
      const text = (chunks as any[])
        .map((c) => c.content)
        .join('\n')
        .trim()
        .slice(0, DRIVE_TEXT_CAP)
      const label = f?.name ? `Document: ${f.name}` : null
      out.set(note.id, {
        noteId: note.id,
        source: 'drive',
        excerpt: [label, text].filter(Boolean).join('\n\n') || null,
      })
    }),
  )
}
