import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { buildAuthUrl } from '@/lib/gmail/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/gmail/authorize?card=gmail-personal
 * Redirects the browser to Google's account chooser + consent screen so the
 * user can pick an account and grant read-only Gmail access.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isGmailCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const url = await buildAuthUrl(auth.email, card)
    return NextResponse.redirect(url)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
