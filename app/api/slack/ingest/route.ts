import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isSlackCard } from '@/lib/slack/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/slack/ingest  { card: "slack-workspace" }
 *
 * Called by the UI right after the Slack card connects. Two jobs, mirroring
 * /api/gmail/ingest:
 *   1. Register/ensure a sync_state row for (user_email, card) with
 *      channel='slack' and the 1-month ingest floor — this is how the GitHub
 *      Actions worker enumerates Slack accounts (Redis token keys are hashed
 *      and not reversible to user+card).
 *   2. Dispatch the slack-backfill workflow, which pulls the last 1 month of
 *      chats and vectorizes them asynchronously.
 *
 * user_email is taken from the NextAuth session — never from the body.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = await req.json().catch(() => ({}))
  if (!isSlackCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  // 1. Ensure the sync_state row exists (idempotent upsert). The 1-month floor
  //    is set once at connect time so re-dispatches keep the same window.
  const oneMonthAgo = new Date()
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)

  const { error: upErr } = await getSupabaseAdmin().from('sync_state').upsert(
    {
      user_email: auth.email,
      card_id: card,
      channel: 'slack',
      backfill_done: false,
      slack_backfill_after: oneMonthAgo.toISOString(),
    },
    { onConflict: 'user_email,card_id' },
  )
  if (upErr) {
    return NextResponse.json({ error: `sync_state: ${upErr.message}` }, { status: 500 })
  }

  // 2. Dispatch the backfill workflow, scoped to this user + card.
  const gh = await fetch(
    `https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/slack-backfill.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { user_email: auth.email, card_id: card },
      }),
    },
  )
  if (!gh.ok) {
    const detail = await gh.text().catch(() => '')
    return NextResponse.json({ error: 'dispatch failed', detail }, { status: 502 })
  }

  return NextResponse.json({ status: 'ingestion queued' }, { status: 202 })
}
