import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { isConnectorKey, getConnectorState } from '@/lib/connectors/state'
import { connectorMeta } from '@/lib/connectors/meta'
import { status as gmailStatus } from '@/lib/gmail/service'
import { status as slackStatus } from '@/lib/slack/service'
import { status as waStatus } from '@/lib/whatsapp/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/connectors/status  { connectorKey }
 *
 * Authoritative liveness for one card, used by the modal's Connect button to
 * decide whether access at the source is genuinely still live (replacing the
 * old hardcoded `sourceStillActive = true`).
 *
 *   - Gmail / Slack / WhatsApp : read the real session/link state. `connected`
 *     is true only when the service reports state === 'connected'.
 *   - Backend-less cards       : there is no source to check, so we report the
 *     persisted toggle as the truth.
 *
 * Returns { connected, backendOwned, detail? }.
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
      const s = await gmailStatus(auth.email, connectorKey)
      return NextResponse.json({
        connected: s.state === 'connected',
        backendOwned: true,
        detail: s.connectedEmail ?? undefined,
      })
    }
    if (meta.service === 'slack') {
      const s = await slackStatus(auth.email, connectorKey)
      return NextResponse.json({
        connected: s.state === 'connected',
        backendOwned: true,
        detail: s.teamName ?? undefined,
      })
    }
    if (meta.service === 'whatsapp') {
      const s = await waStatus(auth.email)
      return NextResponse.json({ connected: s.state === 'connected', backendOwned: true })
    }

    // Backend-less: the persisted toggle is the only truth we have.
    const state = await getConnectorState(auth.email, connectorKey)
    return NextResponse.json({ connected: !!state?.connected, backendOwned: false })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
