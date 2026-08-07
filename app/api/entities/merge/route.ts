import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { mergeEntities } from '@/lib/entities/operations'

export const dynamic = 'force-dynamic'

/**
 * POST /api/entities/merge  { sourceId, targetId }
 * Merges sourceId INTO targetId (v5 §4). Used by both the Pending Review
 * "accept" action and the New Review manual merge. Source is retired
 * (merged_into), ownership is redirected, no Memory Note is rewritten.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { sourceId, targetId } = (await req.json().catch(() => ({}))) as {
    sourceId?: string
    targetId?: string
  }
  if (!sourceId || !targetId) {
    return NextResponse.json({ error: 'sourceId and targetId are required' }, { status: 400 })
  }

  const result = await mergeEntities(auth.email, sourceId, targetId)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
