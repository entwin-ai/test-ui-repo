import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { scan } from '@/lib/gmail/service'

export const dynamic = 'force-dynamic'
// Counting a year of mail is now ~30 list calls per label, but give the
// function headroom on Vercel. Hobby caps at 60s; Pro allows up to 300.
export const maxDuration = 60

/**
 * POST /api/gmail/scan  { card: "gmail-personal" }
 * Parses the last 12 months of INBOX and SENT for the connected account,
 * deduplicates by Message-Id, and returns the two counts. Nothing is stored.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = await req.json().catch(() => ({}))
  if (!isGmailCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    const result = await scan(auth.email, card)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
