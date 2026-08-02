import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { askEntity, NoLlmKeyError } from '@/lib/rag/query'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/wiki  { entityId: string, question?: string }
 * Entity-scoped wiki RAG: answers using only notes that mention the entity.
 * If no question is given, defaults to a general "what do I know about them"
 * summary. user_email from the session; retrieval hard-scoped to it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { entityId, question } = await req.json().catch(() => ({}))
  if (!entityId || typeof entityId !== 'string') {
    return NextResponse.json({ error: 'entityId required' }, { status: 400 })
  }
  const q =
    question && typeof question === 'string' && question.trim()
      ? question
      : 'Summarise everything I know about this person or organisation from my email — who they are, what we have discussed, and anything outstanding.'

  try {
    const result = await askEntity(auth.email, entityId, q)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof NoLlmKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
