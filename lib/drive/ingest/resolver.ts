/**
 * Entity resolution + memory persistence for Drive ingestion (Read Me §2).
 *
 * Drive files use the SAME Resolver mechanism as every other channel (Memory
 * Notes v5 §4, unchanged), and flow through the SAME tables — memory_note ->
 * note_chunk -> entity -> entity_mention -> note_ownership — so a Drive note is
 * unified into the one cross-channel entity graph and retrieval index for free
 * (the design point 0006 established). This module writes exactly one note per
 * ContentUnit and resolves every entity the note surfaces to one of the three
 * Read Me §2 outcomes:
 *   • High confidence -> append to the existing Entity file (alias match).
 *   • No match        -> auto-create a new Entity file.
 *   • Ambiguous       -> create a provisional Entity flagged pending_review.
 *
 * related_entities is NEVER left blank at ingestion (§2): every note resolves to
 * at least the entities its summary named, and a note that surfaces none still
 * gets an empty array explicitly (the frozen field), never null.
 */

import { getSupabaseAdmin } from '@/lib/rag/supabase'
import type { BoundProvider } from '@/lib/rag/provider'
import { stripJson } from '@/lib/rag/provider'
import type { ContentUnit, AuditEntry, ExtractedImage } from './extract'
import type { NoteGranularity } from './rules'

export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Note synthesis — one LLM call per unit, mirroring the Write Memory Note step
// (Memory Notes v5 §1) that Gmail/WhatsApp use. We ask for the same fields the
// memory_note schema stores so a Drive note is shaped identically to an email
// note.
// ---------------------------------------------------------------------------

export interface SynthesizedNote {
  name: string
  summary: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
  lifeDomain: 'personal' | 'professional'
  action: string[]
  confidentiality: 'yes' | 'no' | 'blank'
  entities: { name: string; type?: string }[]
}

const NOTE_SYSTEM = `You write ONE Memory Note summarizing a Google Drive document (or one page/tab of it).
Memory supplements the original file, which stays the source of truth — so summarize at a GIST level, do not reproduce content verbatim.
Fold in any image descriptions, speaker notes, header/footer facts, comments and tracked changes provided.
Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:
{
  "name": "<=8 word title",
  "summary": "2-5 sentence gist. Mention who/what/why and any decision made.",
  "urgency": "critical|high|medium|low",
  "lifeDomain": "personal|professional",
  "action": ["respond"|"give"|"schedule"|"decision"|"await"|"none"],
  "confidentiality": "yes|no|blank",
  "entities": [{"name":"...","type":"person|organisation|unknown"}]
}
Rules:
- entities: the people/orgs the document is actually ABOUT or names substantively. Comment/tracked-change authors count as mentions.
- If a confidentiality marking appears anywhere in the material, set confidentiality to "yes".
- Keep entity extraction high-level; do not invent entities.`

/**
 * Build the user prompt for one unit and call the provider. entityCap, when set,
 * tells the model to keep extraction high-level and NOT enumerate bulk rows —
 * the Excel spreadsheet cap (§3), passed through as an instruction.
 */
export async function synthesizeNote(
  unit: ContentUnit,
  ctx: {
    fileName: string
    kind: string
    facet: string | null
    headerFooterFacts: string[]
    audit: AuditEntry[]
    capEntities?: boolean
    forcedConfidential?: boolean
  },
  provider: BoundProvider,
): Promise<SynthesizedNote> {
  const imgLines = unit.images
    .map((i: ExtractedImage) => `- image (${i.location}): ${i.description || '[no description]'}`)
    .join('\n')
  const auditLines = ctx.audit
    .slice(0, 200) // audit trail is uncapped by size (§4); 200 is a prompt-size guard, not a data cap
    .map((a) => `- ${a.kind}${a.author ? ` by ${a.author}` : ''} [#${a.seq}]: ${a.text}`)
    .join('\n')

  const userPrompt = [
    `File: ${ctx.fileName}  (type: ${ctx.kind}${ctx.facet ? `, facet: ${ctx.facet}` : ''})`,
    ctx.capEntities
      ? 'NOTE: this is a data-heavy sheet — treat like a bulk/updates tier: do NOT extract per-row entities, keep it to the sheet purpose and any headline names.'
      : '',
    ctx.forcedConfidential ? 'A confidentiality marking was detected in this file.' : '',
    ctx.headerFooterFacts.length ? `Header/footer facts:\n${ctx.headerFooterFacts.join('\n')}` : '',
    unit.speakerNotes ? `Speaker notes:\n${unit.speakerNotes}` : '',
    imgLines ? `Images:\n${imgLines}` : '',
    auditLines ? `Comments / tracked changes:\n${auditLines}` : '',
    unit.bodyText ? `Body:\n${unit.bodyText.slice(0, 12000)}` : '(no extractable body text)',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await provider.chatText({ system: NOTE_SYSTEM, user: userPrompt, maxTokens: 900 })
  let parsed: Partial<SynthesizedNote> = {}
  try {
    parsed = JSON.parse(stripJson(raw))
  } catch {
    parsed = {}
  }

  const confidentiality: SynthesizedNote['confidentiality'] = ctx.forcedConfidential
    ? 'yes'
    : parsed.confidentiality === 'yes' || parsed.confidentiality === 'no'
      ? parsed.confidentiality
      : 'blank'

  return {
    name: (parsed.name || ctx.fileName).slice(0, 200),
    summary: parsed.summary || '(no summary produced)',
    urgency: (['critical', 'high', 'medium', 'low'] as const).includes(parsed.urgency as never)
      ? (parsed.urgency as SynthesizedNote['urgency'])
      : 'low',
    lifeDomain: parsed.lifeDomain === 'professional' ? 'professional' : 'personal',
    action: Array.isArray(parsed.action) && parsed.action.length ? parsed.action : ['none'],
    confidentiality,
    entities: Array.isArray(parsed.entities) ? parsed.entities.filter((e) => e && e.name) : [],
  }
}

// ---------------------------------------------------------------------------
// Resolver (§2) — resolve one name to an existing entity (alias/norm match) or
// create a new one. Ambiguity (multiple norm matches) creates a provisional
// entity flagged pending_review. Returns the entity id + how it matched.
// ---------------------------------------------------------------------------

interface ResolveOutcome {
  entityId: string
  matchedAlias: string | null
  outcome: 'high-confidence' | 'no-match' | 'ambiguous'
}

async function resolveEntity(
  userEmail: string,
  name: string,
  type: string | undefined,
  noteDate: string,
): Promise<ResolveOutcome | null> {
  const admin = getSupabaseAdmin()
  const norm = normName(name)
  if (!norm) return null

  // High-confidence: exact norm_name, or the name appears in an entity's aliases.
  const { data: exact } = await admin
    .from('entity')
    .select('id, aliases')
    .eq('user_email', userEmail)
    .eq('norm_name', norm)
    .maybeSingle()
  if (exact) {
    await bumpLastSeen(exact.id, noteDate)
    return { entityId: exact.id, matchedAlias: name, outcome: 'high-confidence' }
  }

  // Alias contains — could be several (ambiguous) or one (high confidence).
  const { data: aliasHits } = await admin
    .from('entity')
    .select('id, aliases')
    .eq('user_email', userEmail)
    .contains('aliases', [name])
  if (aliasHits && aliasHits.length === 1) {
    await bumpLastSeen(aliasHits[0].id, noteDate)
    return { entityId: aliasHits[0].id, matchedAlias: name, outcome: 'high-confidence' }
  }
  if (aliasHits && aliasHits.length > 1) {
    // Ambiguous: create a provisional entity for human resolution (§2). We do
    // NOT silently pick one of the colliding entities.
    const prov = await createEntity(userEmail, name, type, noteDate, true)
    return prov ? { entityId: prov, matchedAlias: name, outcome: 'ambiguous' } : null
  }

  // No match: auto-create a new Entity file (§2), mergeable later.
  const created = await createEntity(userEmail, name, type, noteDate, false)
  return created ? { entityId: created, matchedAlias: name, outcome: 'no-match' } : null
}

async function createEntity(
  userEmail: string,
  name: string,
  type: string | undefined,
  noteDate: string,
  pendingReview: boolean,
): Promise<string | null> {
  const admin = getSupabaseAdmin()
  const base = normName(name)
  for (const candidate of [base, `${base} (${Date.now()})`]) {
    const row: Record<string, unknown> = {
      user_email: userEmail,
      canonical_name: name,
      norm_name: candidate,
      entity_type: type || 'unknown',
      aliases: [name],
      first_seen: noteDate,
      last_seen: noteDate,
    }
    // pending_review is a column added by the entity-review layer (0004/0012);
    // set it best-effort — if the column doesn't exist the insert without it
    // still succeeds on retry.
    if (pendingReview) row.pending_review = true
    const { data, error } = await admin.from('entity').insert(row).select('id').single()
    if (!error && data) return data.id
    // Retry once without pending_review if that column is the problem.
    if (pendingReview) {
      delete row.pending_review
      const retry = await admin.from('entity').insert(row).select('id').single()
      if (!retry.error && retry.data) return retry.data.id
    }
  }
  return null
}

async function bumpLastSeen(entityId: string, noteDate: string): Promise<void> {
  await getSupabaseAdmin()
    .from('entity')
    .update({ last_seen: noteDate, updated_at: new Date().toISOString() })
    .eq('id', entityId)
}

// ---------------------------------------------------------------------------
// Persist one note: memory_note + note_chunk(+embedding) + entity_mention +
// note_ownership. Mirrors the write path the worker uses for other channels.
// ---------------------------------------------------------------------------

export interface PersistInput {
  userEmail: string
  cardId: string
  driveFileId: string
  sourceUrl?: string
  note: SynthesizedNote
  granularity: NoteGranularity
  facet: string | null
  noteDate: string // 'YYYY-MM-DD'
  seq: number // per-file sequence for a unique note_id
}

export async function persistNote(
  input: PersistInput,
  provider: BoundProvider,
  embedApiKey: string,
): Promise<{ noteId: string; entityIds: string[] }> {
  const admin = getSupabaseAdmin()
  const { userEmail, note } = input

  // Resolve every entity the note named (§2) BEFORE writing the note, so
  // related_entities can be frozen onto the note row.
  const resolved: ResolveOutcome[] = []
  for (const e of note.entities) {
    const r = await resolveEntity(userEmail, e.name, e.type, input.noteDate)
    if (r) resolved.push(r)
  }
  const relatedEntities = resolved.map((r) => r.entityId)

  // Stable, once-only note_id: date-source-file-facet-seq.
  const facetTag = input.facet ? input.facet.replace(/[^a-z0-9]+/gi, '-') : 'file'
  const noteIdText = `${input.noteDate}-drive-${input.driveFileId.slice(0, 12)}-${facetTag}-${input.seq}`

  const { data: noteRow, error: noteErr } = await admin
    .from('memory_note')
    .insert({
      user_email: userEmail,
      card_id: input.cardId,
      note_id: noteIdText,
      // gmail_msg_id is nullable since 0006 (WhatsApp/Slack/Drive notes aren't
      // email). It MUST be null, not '' — there is a unique (user_email,
      // gmail_msg_id) index, and '' would collide across every Drive note,
      // whereas SQL NULLs are distinct. source_ref carries the native id.
      gmail_msg_id: null,
      source_ref: input.driveFileId,
      source: 'drive',
      note_date: input.noteDate,
      name: note.name,
      raw_summary: note.summary,
      urgency: note.urgency,
      life_domain: note.lifeDomain,
      action: note.action,
      confidentiality: note.confidentiality,
      related_entities: relatedEntities, // never blank at ingestion (§2)
      source_url: input.sourceUrl || null,
      drive_file_id: input.driveFileId,
      drive_facet: input.facet,
      drive_note_kind: input.granularity,
    })
    .select('id')
    .single()
  if (noteErr || !noteRow) throw new Error(`memory_note insert: ${noteErr?.message}`)
  const noteId = noteRow.id as string

  // note_chunk + embedding (retrieval index). One chunk for the summary is
  // enough at gist level; the original file is the source of truth for detail.
  try {
    const embedding = await provider.embed(`${note.name}\n\n${note.summary}`)
    await admin.from('note_chunk').insert({
      user_email: userEmail,
      card_id: input.cardId,
      note_id: noteId,
      chunk_index: 0,
      content: `${note.name}\n\n${note.summary}`,
      embedding,
    })
  } catch {
    // Embedding is best-effort; a note without a chunk is still queryable by
    // its structured fields and won't strand ingestion.
  }

  // entity_mention + note_ownership for each resolved entity.
  for (const r of resolved) {
    await admin
      .from('entity_mention')
      .insert({ user_email: userEmail, entity_id: r.entityId, note_id: noteId })
      .then(() => {}, () => {}) // ignore unique-violation on re-ingest
    await admin
      .from('note_ownership')
      .insert({
        user_email: userEmail,
        note_id: noteId,
        resolved_entity_id: r.entityId,
        current_entity_id: r.entityId,
        matched_alias: r.matchedAlias,
      })
      .then(() => {}, () => {})
  }

  return { noteId, entityIds: relatedEntities }
}
