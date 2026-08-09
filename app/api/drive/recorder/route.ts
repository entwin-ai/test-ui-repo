import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { setRecorderArmed, status } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/recorder   { card, armed }
 *
 * Backs Chorale's "Turn-on Recorder" toggle. Arming enables Chorale to watch
 * the configured Google Drive folder for Meet's native recording artifacts and
 * dispatch new ones to Babelscribe. It does NOT start or force a Meet
 * recording — Meet only writes an artifact when a host turns recording on in a
 * call (eligible paid tiers), and that is surfaced to participants by Meet's own
 * "recording on" banner. Chorale simply ingests what Meet produces.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = (await req.json().catch(() => ({}))) as { card?: string; armed?: boolean }
  if (!isDriveCard(body.card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  if (typeof body.armed !== 'boolean') {
    return NextResponse.json({ error: 'armed (boolean) is required' }, { status: 400 })
  }

  try {
    await setRecorderArmed(auth.email, body.card, body.armed)
    const s = await status(auth.email, body.card)
    return NextResponse.json({ ok: true, recorderArmed: s.recorderArmed })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
