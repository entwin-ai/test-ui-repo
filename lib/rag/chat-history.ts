import { getSupabaseAdmin } from '@/lib/rag/supabase'

/**
 * Chat history persistence — the store behind the "All chats" tab.
 *
 * It records every rendered turn of an Entwin conversation exactly as the user
 * sees it: the user's message and Entwin's reply, each with role, verbatim
 * text, any sources shown under an answer, whether it was an error bubble, and
 * a timestamp. Turns are grouped into a chat_session (one per "New chat"),
 * identified by a client_id the browser mints.
 *
 * Every function is scoped by userEmail, which the route handler derives
 * server-side from the NextAuth session and NEVER from client input. Backed by
 * chat_session + chat_message (migration 0020).
 */

export type ChatRole = 'user' | 'assistant'

/** A source chip shown beneath an assistant answer (mirrors AskSource). */
export interface ChatSource {
  n: number
  url: string | null
  date: string | null
  urgency: string | null
  channel?: string | null
  similarity?: number
}

/** One turn as sent from the client, in on-screen order. */
export interface IncomingTurn {
  role: ChatRole
  text: string
  sources?: ChatSource[]
  isError?: boolean
  model?: string | null
}

/** One persisted message, as returned to the All chats tab. */
export interface StoredMessage {
  id: string
  role: ChatRole
  text: string
  sources: ChatSource[]
  isError: boolean
  model: string | null
  seq: number
  createdAt: string
}

/** One conversation with its messages, newest conversation first. */
export interface StoredSession {
  clientId: string
  title: string
  createdAt: string
  updatedAt: string
  messages: StoredMessage[]
}

function isRole(v: unknown): v is ChatRole {
  return v === 'user' || v === 'assistant'
}

/** Derive a short, human title from the first user message of a conversation. */
function deriveTitle(turns: IncomingTurn[]): string | null {
  const firstUser = turns.find((t) => t.role === 'user' && t.text.trim())
  if (!firstUser) return null
  const oneLine = firstUser.text.trim().replace(/\s+/g, ' ')
  return oneLine.length > 80 ? oneLine.slice(0, 77) + '\u2026' : oneLine
}

/**
 * Append one or more turns to a conversation, creating the chat_session lazily.
 * Returns the total number of messages now stored in this session so the client
 * can keep its `seq` cursor in sync.
 *
 * Idempotent on (user_email, session_id, seq): re-sending the same turns (e.g.
 * a retried request) will not duplicate rows.
 */
export async function appendTurns(
  userEmail: string,
  clientId: string,
  turns: IncomingTurn[],
): Promise<{ clientId: string; stored: number }> {
  const clean = (turns || []).filter(
    (t) => t && isRole(t.role) && typeof t.text === 'string',
  )
  if (!clientId || typeof clientId !== 'string') {
    throw new Error('clientId required')
  }
  const db = getSupabaseAdmin()

  // Upsert the session row (create on first turn, bump updated_at afterwards).
  const nowIso = new Date().toISOString()
  const { data: sessionRow, error: upsertErr } = await db
    .from('chat_session')
    .upsert(
      { user_email: userEmail, client_id: clientId, updated_at: nowIso },
      { onConflict: 'user_email,client_id' },
    )
    .select('id, title')
    .single()
  if (upsertErr) throw new Error(`chat_session upsert failed: ${upsertErr.message}`)
  const sessionId = sessionRow.id as string

  // Backfill the title from the first user message if we don't have one yet.
  if (!sessionRow.title) {
    const title = deriveTitle(clean)
    if (title) {
      await db
        .from('chat_session')
        .update({ title })
        .eq('user_email', userEmail)
        .eq('id', sessionId)
        .is('title', null)
    }
  }

  if (clean.length === 0) {
    const { count } = await db
      .from('chat_message')
      .select('id', { count: 'exact', head: true })
      .eq('user_email', userEmail)
      .eq('session_id', sessionId)
    return { clientId, stored: count ?? 0 }
  }

  // Find the current max seq to append after it.
  const { data: maxRow } = await db
    .from('chat_message')
    .select('seq')
    .eq('user_email', userEmail)
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle()
  let nextSeq = (maxRow?.seq ?? -1) + 1

  const rows = clean.map((t) => ({
    user_email: userEmail,
    session_id: sessionId,
    client_id: clientId,
    role: t.role,
    text: t.text,
    sources: t.sources ?? [],
    is_error: !!t.isError,
    model: t.model ?? null,
    seq: nextSeq++,
  }))

  const { error: insErr } = await db
    .from('chat_message')
    .upsert(rows, { onConflict: 'user_email,session_id,seq' })
  if (insErr) throw new Error(`chat_message insert failed: ${insErr.message}`)

  // Keep the session's updated_at fresh so it sorts to the top of All chats.
  await db
    .from('chat_session')
    .update({ updated_at: new Date().toISOString() })
    .eq('user_email', userEmail)
    .eq('id', sessionId)

  return { clientId, stored: nextSeq }
}

/**
 * Return every conversation for this user, newest first, each with its messages
 * in on-screen order. `search` (optional) filters to sessions whose title or
 * any message text contains the term. `since` (optional ISO date) filters to
 * conversations last active on/after that instant.
 */
export async function listSessions(
  userEmail: string,
  opts: { search?: string; since?: string; limit?: number } = {},
): Promise<StoredSession[]> {
  const db = getSupabaseAdmin()
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)

  let sessionQuery = db
    .from('chat_session')
    .select('id, client_id, title, created_at, updated_at')
    .eq('user_email', userEmail)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (opts.since) sessionQuery = sessionQuery.gte('updated_at', opts.since)

  const { data: sessions, error: sErr } = await sessionQuery
  if (sErr) throw new Error(`chat_session read failed: ${sErr.message}`)
  if (!sessions || sessions.length === 0) return []

  const sessionIds = sessions.map((s) => s.id as string)

  const { data: msgs, error: mErr } = await db
    .from('chat_message')
    .select('id, session_id, role, text, sources, is_error, model, seq, created_at')
    .eq('user_email', userEmail)
    .in('session_id', sessionIds)
    .order('seq', { ascending: true })
  if (mErr) throw new Error(`chat_message read failed: ${mErr.message}`)

  const bySession = new Map<string, StoredMessage[]>()
  for (const m of msgs ?? []) {
    const list = bySession.get(m.session_id as string) ?? []
    list.push({
      id: m.id as string,
      role: m.role as ChatRole,
      text: m.text as string,
      sources: (m.sources as ChatSource[]) ?? [],
      isError: !!m.is_error,
      model: (m.model as string) ?? null,
      seq: m.seq as number,
      createdAt: m.created_at as string,
    })
    bySession.set(m.session_id as string, list)
  }

  const term = (opts.search ?? '').trim().toLowerCase()

  const result: StoredSession[] = []
  for (const s of sessions) {
    const messages = bySession.get(s.id as string) ?? []
    if (messages.length === 0) continue // skip empty shells
    const title = (s.title as string) || messages.find((m) => m.role === 'user')?.text || 'Untitled chat'

    if (term) {
      const hitTitle = title.toLowerCase().includes(term)
      const hitBody = messages.some((m) => m.text.toLowerCase().includes(term))
      if (!hitTitle && !hitBody) continue
    }

    result.push({
      clientId: s.client_id as string,
      title,
      createdAt: s.created_at as string,
      updatedAt: s.updated_at as string,
      messages,
    })
  }

  return result
}
