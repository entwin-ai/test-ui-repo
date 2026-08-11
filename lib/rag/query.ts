import { getSupabaseAdmin } from './supabase'
import { getLlmConfig } from './llm-keys'
import { makeProvider } from './provider'
import { hydrateNotes } from './hydrate'

// How many of the top matched notes to hydrate with verbatim source excerpts.
// Bounded so email bodies / conversation windows can't blow the context or cost;
// the remaining matches still contribute their distilled summary.
const HYDRATE_TOP_K = 5

// Human-readable channel label for a note's `source`.
function channelLabel(source: string | null | undefined): string {
  switch (source) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'slack':
      return 'Slack'
    case 'drive':
      return 'Google Drive'
    default:
      return 'email'
  }
}

/**
 * RAG retrieval + answer, provider-agnostic. The user's LLM key/provider is
 * loaded from the encrypted Redis store; the same key does both the query
 * embedding and the answer generation. `userEmail` is the hard isolation scope.
 */

export interface AskSource {
  n: number
  url: string | null
  date: string | null
  urgency: string | null
  channel: string | null // 'email' | 'whatsapp' — which connector this came from
  similarity: number
}

export interface AskResult {
  answer: string
  sources: AskSource[]
}

export class NoLlmKeyError extends Error {
  constructor() {
    super('No LLM key configured. Set one in Settings.')
    this.name = 'NoLlmKeyError'
  }
}

export async function ask(
  userEmail: string,
  question: string,
  cardId: string | null = null,
): Promise<AskResult> {
  const config = await getLlmConfig(userEmail)
  if (!config) throw new NoLlmKeyError()
  const provider = makeProvider(config)

  const queryEmbedding = await provider.embed(question)

  // Detect recency intent ("latest", "recent", "last", "newest", "most recent")
  // so the retrieval can bias toward newer notes — vector search alone has no
  // notion of time.
  const recencyBoost = /\b(latest|most recent|recent|newest|last|current)\b/i.test(question)

  // Hybrid retrieval: vector + keyword + optional recency. Passing the raw
  // question text powers the keyword arm, which rescues exact terms (e.g. RSVP)
  // that pure semantic search can miss.
  const { data: matches, error } = await getSupabaseAdmin().rpc('match_note_chunks_hybrid', {
    p_user_email: userEmail, // HARD user scope
    query_embedding: queryEmbedding,
    p_query_text: question,
    match_count: 15,
    p_card_id: cardId,
    p_recency_boost: recencyBoost,
  })
  if (error) throw new Error(error.message)

  if (!matches || matches.length === 0) {
    return { answer: "I couldn't find anything in your email memory about that.", sources: [] }
  }

  // If the user asked for the "latest/most recent", order the context by date
  // (newest first) so the model reads the most recent match first.
  const ordered = recencyBoost
    ? [...(matches as any[])].sort((a, b) => (a.note_date < b.note_date ? 1 : -1))
    : (matches as any[])

  // Hydrate the top matches with verbatim source excerpts (raw email / WhatsApp
  // / Slack / Drive) so the model can elaborate with specifics the distilled
  // summary omits, instead of answering from the summary alone.
  const hydrated = await hydrateNotes(
    userEmail,
    ordered.slice(0, HYDRATE_TOP_K).map((m: any) => m.note_id),
  )

  // Label each context block with its channel so the model can attribute
  // cross-channel answers ("you agreed this over WhatsApp"), and append the raw
  // excerpt beneath the summary where we have one.
  const context = ordered
    .map((m: any, i: number) => {
      const h = hydrated.get(m.note_id)
      const block = `[${i + 1}] (${channelLabel(m.source)}, ${m.note_date}, urgency=${m.urgency})\nSummary: ${m.content}`
      return h?.excerpt ? `${block}\nVerbatim source excerpt:\n${h.excerpt}` : block
    })
    .join('\n\n')

  const recencyHint = recencyBoost
    ? ' The notes are ordered newest-first; when the user asks for the "latest" or "most recent", prefer the newest relevant note.'
    : ''

  const answer = await provider.chatText({
    system:
      'Answer the question using ONLY the provided memory notes, which come from the user\'s email, WhatsApp, Slack, and Google Drive documents. Each note is tagged with its channel and carries a distilled Summary; many also include a "Verbatim source excerpt" — the actual message thread, email body, or document passage. Prefer the verbatim excerpt for specific details and quote from it directly when helpful; use the summary for framing. Cite sources as [n]. When it matters, mention which channel something came from. If the notes do not contain the answer, say so plainly.' +
      recencyHint,
    user: `Question: ${question}\n\nMemory notes:\n${context}`,
    maxTokens: 1024,
  })

  const seen = new Set<string>()
  const sources: AskSource[] = []
  let n = 0
  for (const m of ordered) {
    const key = m.gmail_msg_id || m.source_url || String(m.note_id)
    if (seen.has(key)) continue
    seen.add(key)
    n += 1
    sources.push({
      n,
      url: m.source_url,
      date: m.note_date,
      urgency: m.urgency,
      channel: m.source ?? 'email',
      similarity: m.score,
    })
  }

  return { answer, sources }
}

/**
 * Wiki RAG: "what do I know about entity X?" Retrieves chunks only from notes
 * that mention the given entity (via match_entity_chunks), then answers with the
 * user's LLM. Same isolation guarantees as ask().
 */
export async function askEntity(
  userEmail: string,
  entityId: string,
  question: string,
): Promise<AskResult> {
  const config = await getLlmConfig(userEmail)
  if (!config) throw new NoLlmKeyError()
  const provider = makeProvider(config)

  const queryEmbedding = await provider.embed(question)

  const { data: matches, error } = await getSupabaseAdmin().rpc('match_entity_chunks', {
    p_user_email: userEmail,
    p_entity_id: entityId,
    query_embedding: queryEmbedding,
    match_count: 12,
  })
  if (error) throw new Error(error.message)

  if (!matches || matches.length === 0) {
    return { answer: "I don't have anything in your email memory about that yet.", sources: [] }
  }

  const hydrated = await hydrateNotes(
    userEmail,
    (matches as any[]).slice(0, HYDRATE_TOP_K).map((m) => m.note_id),
  )

  const context = (matches as any[])
    .map((m, i) => {
      const h = hydrated.get(m.note_id)
      const block = `[${i + 1}] (${channelLabel(m.source)}, ${m.note_date}, urgency=${m.urgency})\nSummary: ${m.content}`
      return h?.excerpt ? `${block}\nVerbatim source excerpt:\n${h.excerpt}` : block
    })
    .join('\n\n')

  const answer = await provider.chatText({
    system:
      'You are summarising what the user knows about a specific person or organisation, drawing on their email, WhatsApp, Slack, and Google Drive memory notes (each tagged with its channel). Each note carries a distilled Summary; many also include a "Verbatim source excerpt" — the actual message thread, email body, or document passage. Prefer the verbatim excerpt for specific details and quote from it directly when helpful. Cite sources as [n]. If the notes do not answer, say so plainly.',
    user: `Question: ${question}\n\nMemory notes:\n${context}`,
    maxTokens: 1024,
  })

  const seen = new Set<string>()
  const sources: AskSource[] = []
  let n = 0
  for (const m of matches as any[]) {
    const key = m.gmail_msg_id || m.source_url || String(m.note_id)
    if (seen.has(key)) continue
    seen.add(key)
    n += 1
    sources.push({
      n,
      url: m.source_url,
      date: m.note_date,
      urgency: m.urgency,
      channel: m.source ?? 'email',
      similarity: m.similarity,
    })
  }

  return { answer, sources }
}
