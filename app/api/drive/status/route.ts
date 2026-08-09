import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { status } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/drive/status?card=chorale-recorder
 * Returns the Drive connection state, granted write access, and any previously
 * selected folder for the card — used to hydrate the Chorale card on load.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isDriveCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const s = await status(auth.email, card)
    return NextResponse.json(s)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
