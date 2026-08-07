import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { isConnectorKey, upsertConnectorState } from '@/lib/connectors/state'
import { connectorMeta } from '@/lib/connectors/meta'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { disconnect as gmailDisconnect } from '@/lib/gmail/service'
import { disconnect as slackDisconnect } from '@/lib/slack/service'
import { disconnect as waDisconnect } from '@/lib/whatsapp/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/connectors/disconnect  { connectorKey }
 *
 * The real disconnect behind the connector settings modal's Disconnect button.
 * Previously the modal only showed an alert and flipped a local flag; a
 * re-connect always bounced straight back because `sourceStillActive` was
 * hardcoded true. This performs the actual teardown per connector type:
 *
 *   - Gmail / Slack : revoke the stored session/token AND delete the sync_state
 *     row so the worker stops polling the account (mirrors the per-service
 *     disconnect routes). Ingested notes are left intact.
 *   - WhatsApp      : unlink the device (drops creds/keys), stopping capture.
 *   - Backend-less  : nothing to revoke; we just persist the toggle.
 *
 * In every case connector_state.connected is set to false so the grid and the
 * modal agree with the backend on the next status read.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { connectorKey } = await req.json().catch(() => ({}))
  if (!isConnectorKey(connectorKey)) {
    return NextResponse.json({ error: 'Invalid or missing connectorKey' }, { status: 400 })
  }

  const meta = connectorMeta(connectorKey)

  try {
    if (meta.service === 'gmail') {
      await gmailDisconnect(auth.email, connectorKey)
      await getSupabaseAdmin()
        .from('sync_state')
        .delete()
        .eq('user_email', auth.email)
        .eq('card_id', connectorKey)
    } else if (meta.service === 'slack') {
      await slackDisconnect(auth.email, connectorKey)
      await getSupabaseAdmin()
        .from('sync_state')
        .delete()
        .eq('user_email', auth.email)
        .eq('card_id', connectorKey)
    } else if (meta.service === 'whatsapp') {
      await waDisconnect(auth.email)
    }
    // Backend-less cards: nothing external to revoke.

    // Persist the toggle so the grid + modal reflect the disconnect immediately.
    const state = await upsertConnectorState(auth.email, connectorKey, { connected: false })
    return NextResponse.json({ ok: true, state })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
