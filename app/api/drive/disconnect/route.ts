import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard, isDriveIngestCard } from '@/lib/drive/route-helpers'
import { disconnect } from '@/lib/drive/service'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/disconnect  { card }
 *
 * Clears the server-side Drive session/token for the card (both the Chorale
 * write card and the Drive-ingest cards use this). For an INGEST card it also
 * tears down the per-card scan bookkeeping so a later reconnect starts fresh:
 *   • drive_file ledger rows (the diff state) for this card, and
 *   • the sync_state row that scheduled the daily scan.
 *
 * It deliberately does NOT delete already-written Memory Notes — disconnecting a
 * source is not the same as forgetting what it taught the twin. "Kill My Twin"
 * (DELETE /api/twin) is the tool that wipes memory. The user_email is taken from
 * the session, never the body.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = (await req.json().catch(() => ({}))) as { card?: string }
  if (!isDriveCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  try {
    await disconnect(auth.email, card)

    if (isDriveIngestCard(card)) {
      const admin = getSupabaseAdmin()
      // Best-effort: drop diff ledger + scan schedule for this card only.
      await admin
        .from('drive_file')
        .delete()
        .eq('user_email', auth.email)
        .eq('card_id', card)
        .then(() => {}, () => {})
      await admin
        .from('sync_state')
        .delete()
        .eq('user_email', auth.email)
        .eq('card_id', card)
        .then(() => {}, () => {})
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
