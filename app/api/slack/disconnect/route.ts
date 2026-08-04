import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isSlackCard } from '@/lib/slack/route-helpers'
import { disconnect } from '@/lib/slack/service'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/** POST /api/slack/disconnect  { card: "slack-workspace" } */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = await req.json().catch(() => ({}))
  if (!isSlackCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  await disconnect(auth.email, card)
  // Stop future syncs for this account. Ingested notes are left intact; delete
  // them explicitly via a data-removal action if the user asks.
  await getSupabaseAdmin()
    .from('sync_state')
    .delete()
    .eq('user_email', auth.email)
    .eq('card_id', card)
  return NextResponse.json({ ok: true })
}

