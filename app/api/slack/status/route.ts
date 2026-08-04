import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isSlackCard } from '@/lib/slack/route-helpers'
import { status } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'

/** GET /api/slack/status?card=slack-workspace */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isSlackCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  return NextResponse.json(await status(auth.email, card))
}
