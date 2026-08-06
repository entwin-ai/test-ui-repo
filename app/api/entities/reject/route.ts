import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { rejectPendingReview } from '@/lib/entities/operations'

export const dynamic = 'force-dynamic'

/**
 * POST /api/entities/reject  { entityId }
 * The Pending Review "reject" action (v5 §4): the provisional entity is
 * genuinely distinct — clear the flag, it stands on its own going forward.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { entityId } = (await req.json().catch(() => ({}))) as { entityId?: string }
  if (!entityId) return NextResponse.json({ error: 'entityId is required' }, { status: 400 })

  const result = await rejectPendingReview(auth.email, entityId)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
