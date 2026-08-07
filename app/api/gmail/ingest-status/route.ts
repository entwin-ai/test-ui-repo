import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isGmailCard } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/gmail/ingest-status?card=gmail-personal
 *
 * Reports the ingestion progress for one Gmail card, from the database — the
 * source of truth the gmail-calibrate / backfill worker writes to:
 *
 *   - ingestedCount : count(email_message) for (user, card). Each row is one
 *     email the worker has pulled into the vault. This is the "X emails
 *     ingested" number the card shows.
 *   - phase / done  : from sync_state.onboard_phase + backfill_done. Ingestion
 *     is considered still in progress while a sync_state row exists but hasn't
 *     reached a terminal phase; "done" once calibration/backfill has completed.
 *
 * All scoped by the session email, never request input.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isGmailCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  const supa = getSupabaseAdmin()

  // 1. How many emails have been ingested so far for this card.
  const { count, error: countErr } = await supa
    .from('email_message')
    .select('*', { count: 'exact', head: true })
    .eq('user_email', auth.email)
    .eq('card_id', card)
  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 })
  }
  const ingestedCount = count ?? 0

  // 2. Ingestion phase from sync_state (may not exist yet if never dispatched).
  const { data: ss } = await supa
    .from('sync_state')
    .select('onboard_phase, backfill_done')
    .eq('user_email', auth.email)
    .eq('card_id', card)
    .maybeSingle()

  // Terminal phases: the worker sets onboard_phase to 'calibrated' after the
  // calibration ingest completes, and 'done' after the full backfill. Either,
  // or backfill_done === true, means ingestion is no longer in progress.
  const phase: string | null = ss?.onboard_phase ?? null
  const done =
    !!ss &&
    (ss.backfill_done === true || phase === 'calibrated' || phase === 'done')

  // "In progress" = a sync_state row exists (ingestion was dispatched) but hasn't
  // reached a terminal phase yet.
  const inProgress = !!ss && !done

  return NextResponse.json({ card, ingestedCount, phase, done, inProgress })
}
