import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { appendTurns, listSessions, type IncomingTurn } from '@/lib/rag/chat-history'

export const dynamic = 'force-dynamic'

/**
 * GET /api/chats?search=&since=
 *   Returns every conversation for the signed-in user, newest first, each with
 *   its messages in on-screen order. Powers the "All chats" tab.
 *
 * POST /api/chats  { clientId: string, turns: IncomingTurn[] }
 *   Appends one or more rendered turns to a conversation (created lazily).
 *
 * user_email always comes from the NextAuth session, never from client input.
 */

export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const url = new URL(req.url)
  const search = url.searchParams.get('search') || undefined
  const since = url.searchParams.get('since') || undefined

  try {
    const sessions = await listSessions(auth.email, { search, since })
    return NextResponse.json({ sessions })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({}))
  const clientId = typeof body?.clientId === 'string' ? body.clientId : ''
  const turns = Array.isArray(body?.turns) ? (body.turns as IncomingTurn[]) : []

  if (!clientId) {
    return NextResponse.json({ error: 'clientId required' }, { status: 400 })
  }

  try {
    const res = await appendTurns(auth.email, clientId, turns)
    return NextResponse.json(res)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
