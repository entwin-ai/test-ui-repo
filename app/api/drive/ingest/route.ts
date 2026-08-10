import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveIngestCard } from '@/lib/drive/route-helpers'
import { getIngestFolders } from '@/lib/drive/service'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'
import { runDriveIngest } from '@/lib/drive/ingest/pipeline'
import type { ScanTrigger } from '@/lib/drive/ingest/rules'

export const dynamic = 'force-dynamic'
// Only the in-process FALLBACK path (no GH Actions configured) does heavy work;
// the normal path just dispatches a workflow and returns fast. Keep headroom.
export const maxDuration = 300

/**
 * POST /api/drive/ingest  { card: "drive-personal", trigger?: "first-connect" | "forced-refresh" }
 *
 * Called by the UI after the user connects a Drive-ingest card and picks the
 * folder(s) to watch. Like Gmail's connect flow (which dispatches calibrate.yml),
 * this now DISPATCHES A GITHUB ACTION so the first-connect ingestion is a
 * visible run in the Actions tab rather than blocking the request:
 *
 *   1. Registers/ensures a sync_state row for (user_email, card) — channel='drive'
 *      — so the dispatched job (and the daily-scan cron) can enumerate this
 *      account.
 *   2. Dispatches drive-ingest.yml scoped to this user. That workflow calls the
 *      app's /api/drive/scan-all endpoint (trigger=first-connect, force) which
 *      runs the real pipeline: read every file in full -> Memory Notes (Read Me
 *      §1). Drive's pipeline lives in the app, so the workflow is a thin visible
 *      trigger — the same pattern drive-scan.yml uses for the daily scan.
 *
 * FALLBACK: if GH_REPO / GH_DISPATCH_TOKEN aren't configured (e.g. local dev with
 * no Actions), we run the pipeline in-process so the feature still works, and say
 * so in the response.
 *
 * The user_email is taken from the session — never from the body — so a user can
 * only ever ingest their own Drive.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({}))
  const card = body?.card
  if (!isDriveIngestCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing Drive ingest card id' }, { status: 400 })
  }
  const trigger: ScanTrigger =
    body?.trigger === 'forced-refresh' ? 'forced-refresh' : 'first-connect'

  // Must have at least one selected folder (Read Me §1 Scope — only selected
  // folders are ever read).
  const folders = await getIngestFolders(auth.email, card)
  if (!folders.length) {
    return NextResponse.json(
      { error: 'Select at least one Drive folder to ingest first.' },
      { status: 400 },
    )
  }

  // 1. Ensure the sync_state row (idempotent). Drive has no sender-calibration
  //    step, so onboarding goes straight to 'confirmed' — there is no Kanban
  //    handshake for Drive. channel='drive' keeps these rows out of the Gmail
  //    delta cron's sweep and lets the Drive jobs find them.
  const { error: upErr } = await getSupabaseAdmin().from('sync_state').upsert(
    {
      user_email: auth.email,
      card_id: card,
      channel: 'drive',
      backfill_done: false,
      onboard_phase: 'confirmed',
    },
    { onConflict: 'user_email,card_id' },
  )
  if (upErr) {
    return NextResponse.json({ error: `sync_state: ${upErr.message}` }, { status: 500 })
  }

  // 2. Dispatch the visible GitHub Action (preferred path).
  const ghConfigured = Boolean(process.env.GH_REPO && process.env.GH_DISPATCH_TOKEN)
  if (ghConfigured) {
    const dispatch = await dispatchWorkflow('drive-ingest.yml', {
      user_email: auth.email,
      card_id: card,
      trigger,
    })
    if (!dispatch.ok) {
      return NextResponse.json(
        { error: 'dispatch failed', detail: dispatch.detail },
        { status: 502 },
      )
    }
    // 202 Accepted: the run is queued and will appear in the Actions tab. The
    // job stamps sync_state.last_delta_at when it finishes.
    return NextResponse.json(
      { status: 'ingestion queued', dispatched: true, workflow: 'drive-ingest.yml' },
      { status: 202 },
    )
  }

  // 2b. FALLBACK — no Actions configured: run the pipeline in-process so the
  //     feature still works locally.
  try {
    const report = await runDriveIngest({
      userEmail: auth.email,
      cardId: card,
      folderIds: folders.map((f) => f.id),
      trigger,
      maxFiles: trigger === 'first-connect' ? 200 : 500,
    })
    if (report.ok) {
      await getSupabaseAdmin()
        .from('sync_state')
        .update({
          backfill_done: true,
          last_delta_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_email', auth.email)
        .eq('card_id', card)
    }
    return NextResponse.json(
      { ...report, dispatched: false, ranInProcess: true },
      { status: report.ok ? 200 : 207 },
    )
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
