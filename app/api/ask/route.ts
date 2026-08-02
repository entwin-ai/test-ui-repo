import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { ask, NoLlmKeyError } from '@/lib/rag/query'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/ask  { question: string, card?: "gmail-personal" | "gmail-professional" }
 *
 * Retrieval-augmented answer over the signed-in user's email memory, using the
 * user's own LLM key from Settings. user_email comes from the NextAuth session;
 * retrieval is hard-scoped to it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { question, card } = await req.json().catch(() => ({}))
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'question required' }, { status: 400 })
  }
  const cardId = isGmailCard(card) ? card : null

  try {
    const result = await ask(auth.email, question, cardId)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof NoLlmKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
