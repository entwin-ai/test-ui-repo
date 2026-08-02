import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { status } from '@/lib/gmail/service'

export const dynamic = 'force-dynamic'

/** GET /api/gmail/status?card=gmail-personal */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isGmailCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  return NextResponse.json(await status(auth.email, card))
}
