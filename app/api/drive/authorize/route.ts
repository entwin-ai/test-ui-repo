import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { buildAuthUrl } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/drive/authorize?card=chorale-recorder
 * Redirects the browser to Google's account chooser + consent screen so the
 * user re-validates their Google account and grants Drive WRITE (drive.file)
 * access. On return, /api/drive/callback bounces back to the app, which then
 * opens the Drive Explorer for folder selection.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isDriveCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const url = await buildAuthUrl(auth.email, card)
    return NextResponse.redirect(url)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
