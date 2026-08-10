import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveIngestCard } from '@/lib/drive/route-helpers'
import { getIngestFolders } from '@/lib/drive/service'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { runDriveIngest } from '@/lib/drive/ingest/pipeline'
import type { ScanTrigger } from '@/lib/drive/ingest/rules'

export const dynamic = 'force-dynamic'
// Ingestion reads + LLM-summarizes files; give it room beyond the default.
export const maxDuration = 300

/**
 * POST /api/drive/ingest  { card: "drive-personal", trigger?: "first-connect" | "daily-scan" | "forced-refresh" }
 *
 * Called by the UI after the user connects a Drive-ingest card and picks the
 * folder(s) to watch. It:
 *   1. Registers/ensures a sync_state row for (user_email, card) so the daily
 *      GitHub Actions scan can enumerate this account — the same mechanism Gmail
 *      uses (Redis token keys are hashed and not reversible to user+card).
 *   2. Runs the ingestion pipeline in-process for the selected folders: read →
 *      diff → extract → vision → synthesize Memory Notes → resolve entities →
 *      persist (Read Me §1–§4). For a large vault the daily worker takes over on
 *      cadence; this first pass covers the "first connection: read every file"
 *      requirement (§1).
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
    body?.trigger === 'forced-refresh'
      ? 'forced-refresh'
      : body?.trigger === 'daily-scan'
        ? 'daily-scan'
        : 'first-connect'

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
  //    delta cron's sweep (which filters channel='gmail') and lets the Drive
  //    daily-scan cron find them.
  const { error: upErr } = await getSupabaseAdmin().from('sync_state').upsert(
    {
      user_email: auth.email,
      card_id: card,
      channel: 'drive',
      backfill_done: trigger === 'first-connect' ? false : true,
      onboard_phase: 'confirmed',
    },
    { onConflict: 'user_email,card_id' },
  )
  if (upErr) {
    return NextResponse.json({ error: `sync_state: ${upErr.message}` }, { status: 500 })
  }

  // 2. Run the pipeline for the selected folders.
  try {
    const report = await runDriveIngest({
      userEmail: auth.email,
      cardId: card,
      folderIds: folders.map((f) => f.id),
      trigger,
      // First pass is bounded so the request returns; the daily worker (or a
      // repeat forced refresh) continues any remainder on cadence.
      maxFiles: trigger === 'first-connect' ? 200 : 500,
    })

    // Mark the backfill done once a first-connect pass completes without a hard
    // failure, so the daily scan takes over in diff mode from here. Stamp
    // last_delta_at too — it's the per-user cadence anchor the daily-scan cron
    // compares against pollHours to decide if a user is "due".
    if (trigger === 'first-connect' && report.ok) {
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

    return NextResponse.json(report, { status: report.ok ? 200 : 207 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
