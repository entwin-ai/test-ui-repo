import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isSlackCard } from '@/lib/slack/route-helpers'
import { buildAuthUrl } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/slack/authorize?card=slack-workspace
 * Redirects the browser to Slack's consent screen so the user can grant
 * read access to their channels and DMs.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isSlackCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const url = await buildAuthUrl(auth.email, card)
    return NextResponse.redirect(url)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
