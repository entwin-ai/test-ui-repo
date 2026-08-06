import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/gmail/ingest  { card: "gmail-personal" }
 *
 * Called by the UI after a Gmail card is connected (and scanned). Two jobs:
 *   1. Register/ensure a sync_state row for (user_email, card) — this is how the
 *      GitHub Actions worker enumerates accounts, since Redis token keys are
 *      hashed and not reversible to user+card.
 *   2. Dispatch the one-year backfill workflow for this account.
 *
 * The user_email is taken from the NextAuth session — never from the body.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { card } = await req.json().catch(() => ({}))
  if (!isGmailCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  // 1. Ensure the sync_state row exists (idempotent upsert). Start onboarding at
  //    the calibration phase — the full backfill waits until the user confirms
  //    the sender classification on the Kanban (Email Ingestion Read Me).
  const { error: upErr } = await getSupabaseAdmin().from('sync_state').upsert(
    { user_email: auth.email, card_id: card, backfill_done: false, onboard_phase: 'calibrating' },
    { onConflict: 'user_email,card_id' },
  )
  if (upErr) {
    return NextResponse.json({ error: `sync_state: ${upErr.message}` }, { status: 500 })
  }

  // 2. Dispatch the 90-day CALIBRATION workflow (senders only, no Memory Notes),
  //    scoped to this user + card. Full ingestion is dispatched later, after the
  //    user confirms on the Kanban (see POST /api/gmail/confirm-onboarding).
  const gh = await fetch(
    `https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/calibrate.yml/dispatches`,
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

  return NextResponse.json({ status: 'calibration queued' }, { status: 202 })
}
