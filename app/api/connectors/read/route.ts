import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { isConnectorKey, touchLastRead } from '@/lib/connectors/state'
import { connectorMeta } from '@/lib/connectors/meta'
import { scan as gmailScan } from '@/lib/gmail/service'
import { scan as slackScan } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/connectors/read  { connectorKey }
 *
 * The "Read Now" button on the connector settings modal. Two things happen:
 *
 *   1. For a BACKEND-OWNED connector (Gmail / Slack / WhatsApp) it triggers a
 *      real on-demand read — a Gmail/Slack scan, or a WhatsApp sync dispatch —
 *      exactly what the recurring poll would do, but now.
 *   2. It records `last_read_at` on the connector_state row so the modal's
 *      "Last read" line stops saying "Never".
 *
 * For a backend-less card (Drive, Calendar, Browser history, Animatics) there's
 * nothing to fetch yet, so it only records the timestamp — the honest behavior
 * rather than faking a read.
 *
 * The timestamp is always recorded, even if the underlying read errors, because
 * "we attempted a read at T" is what the line reflects; the read's own outcome
 * is returned separately so the UI can surface a failure.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { connectorKey } = await req.json().catch(() => ({}))
  if (!isConnectorKey(connectorKey)) {
    return NextResponse.json({ error: 'Invalid or missing connectorKey' }, { status: 400 })
  }

  const meta = connectorMeta(connectorKey)
  let read: { attempted: boolean; ok: boolean; detail?: string } = { attempted: false, ok: true }

  try {
    if (meta.readKind === 'gmail-scan') {
      await gmailScan(auth.email, connectorKey)
      read = { attempted: true, ok: true }
    } else if (meta.readKind === 'slack-scan') {
      await slackScan(auth.email, connectorKey)
      read = { attempted: true, ok: true }
    } else if (meta.readKind === 'wa-sync') {
      // WhatsApp reads run in the worker; nudge the workflow if dispatch is
      // configured (same fire-and-forget as /api/whatsapp/sync).
      if (process.env.GH_REPO && process.env.GH_DISPATCH_TOKEN) {
        await fetch(
          `https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/whatsapp-sync.yml/dispatches`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({ ref: 'main', inputs: { user_email: auth.email } }),
          },
        ).catch(() => {})
      }
      read = { attempted: true, ok: true, detail: 'Sync requested.' }
    }
  } catch (e) {
    read = { attempted: true, ok: false, detail: (e as Error).message }
  }

  // Always record the attempt timestamp.
  let lastReadAt: string | null = null
  try {
    lastReadAt = await touchLastRead(auth.email, connectorKey)
  } catch (e) {
    return NextResponse.json(
      { error: `Read ran but the timestamp could not be saved: ${(e as Error).message}`, read },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: read.ok, lastReadAt, read })
}
