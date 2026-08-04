import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isSlackCard } from '@/lib/slack/route-helpers'
import { scan } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'
// Walking every conversation's last-month history is many Slack calls; give the
// function headroom. Hobby caps at 60s; Pro allows up to 300.
export const maxDuration = 60

/**
 * POST /api/slack/scan  { card: "slack-workspace" }
 * Pulls the last 1 month of messages across every conversation the user can
 * read and returns per-channel + total counts. Content is not persisted here.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = await req.json().catch(() => ({}))
  if (!isSlackCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const result = await scan(auth.email, card)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
