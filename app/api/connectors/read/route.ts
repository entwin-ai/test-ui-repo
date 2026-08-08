import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { isConnectorKey, touchLastRead } from '@/lib/connectors/state'
import { connectorMeta } from '@/lib/connectors/meta'
import { scan as slackScan } from '@/lib/slack/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Fire a GitHub Actions workflow_dispatch. Returns a short outcome for the UI. */
async function dispatchWorkflow(
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  const repo = process.env.GH_REPO
  const token = process.env.GH_DISPATCH_TOKEN
  if (!repo || !token) {
    return { ok: false, detail: 'Ingestion worker not configured (GH_REPO / GH_DISPATCH_TOKEN unset).' }
  }
  const ref = process.env.GH_WORKFLOW_REF || 'main'
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref, inputs }),
    },
  )
  // 204 No Content = accepted.
  if (res.status === 204) return { ok: true, detail: 'Read requested.' }
  const body = await res.text().catch(() => '')
  return { ok: false, detail: `Dispatch failed (${res.status})${body ? `: ${body.slice(0, 140)}` : ''}` }
}

/**
 * POST /api/connectors/read  { connectorKey }
 *
 * The "Read Now" button on the connector settings modal. Two things happen:
 *
 *   1. For a BACKEND-OWNED connector it triggers a real on-demand read:
 *        - Gmail    → dispatches the gmail-delta GitHub Action (forced, scoped
 *                     to this user + card) to pull new/changed mail now.
 *        - Slack    → an on-demand scan.
 *        - WhatsApp → dispatches the whatsapp-delta workflow (capture + vectorize).
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
    if (meta.readKind === 'gmail-delta') {
      // "Read Now" for Gmail triggers the gmail-delta GitHub Action scoped to
      // this user + card, forcing an immediate differential read (bypassing the
      // per-user cadence gate). The worker pulls only new/changed mail.
      read = { attempted: true, ...(await dispatchWorkflow('delta.yml', {
        user_email: auth.email,
        card_id: connectorKey,
        force: 'true',
      })) }
    } else if (meta.readKind === 'slack-scan') {
      await slackScan(auth.email, connectorKey)
      read = { attempted: true, ok: true }
    } else if (meta.readKind === 'wa-sync') {
      // "Read Now" for WhatsApp triggers the whatsapp-delta GitHub Action scoped
      // to this user: it drains the offline backlog (the difference since the
      // last read) and vectorizes it — an immediate, on-demand differential read.
      read = { attempted: true, ...(await dispatchWorkflow('whatsapp-delta.yml', {
        user_email: auth.email,
      })) }
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
