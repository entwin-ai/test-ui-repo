import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { getConnectorState } from '@/lib/connectors/state'
import { getIngestFolders } from '@/lib/drive/service'
import { runDriveIngest } from '@/lib/drive/ingest/pipeline'
import { isDriveIngestCard } from '@/lib/drive/route-helpers'

export const dynamic = 'force-dynamic'
// The scan touches many users' folders + LLM; give it the max serverless window.
export const maxDuration = 300

/**
 * POST /api/drive/scan-all      (called by the drive-scan.yml cron heartbeat)
 *
 * The recurring "once-per-day scan" the Read Me §1 mandates. Because Drive's
 * ingestion pipeline lives in the app (not the worker), the cron can't run it
 * directly the way the Gmail/Slack/WhatsApp crons run worker code — instead the
 * cron POSTs here on a coarse heartbeat and this endpoint does the per-user work.
 *
 * HEARTBEAT + PER-USER CADENCE (mirrors delta.yml's model):
 *   • The cron fires hourly. On each tick we enumerate every Drive row in
 *     sync_state (channel='drive').
 *   • For each, we read that user's chosen "Reading frequency"
 *     (connector_state.settings.pollHours) and run a daily-scan ONLY if that
 *     many hours have elapsed since sync_state.last_delta_at. So a user on 24h
 *     scans once a day, a user on 6h four times a day — all off one schedule.
 *   • last_delta_at is stamped after each successful run, so the next tick can
 *     tell who's due. NULL last_delta_at = never scanned since connect = due now.
 *
 * AUTH: there is no user session on a cron call, so this route is gated by a
 * shared CRON_SECRET bearer token (set as a GitHub secret and a server env var).
 * It never trusts a user_email from the body for anything except optional
 * single-user scoping on a manual dispatch — the work is service-role scoped by
 * the sync_state rows themselves.
 *
 * Optional body: { user_email?: string, force?: boolean }
 *   user_email — scope the scan to one user (manual dispatch / debugging).
 *   force      — bypass the pollHours cadence gate (run every due-or-not row).
 */
export async function POST(req: NextRequest) {
  // --- auth: shared secret, constant-time compared ---
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on the server' },
      { status: 503 },
    )
  }
  const provided = bearer(req.headers.get('authorization')) || req.headers.get('x-cron-secret') || ''
  if (!safeEqual(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    user_email?: string
    force?: boolean
    trigger?: 'first-connect' | 'daily-scan' | 'forced-refresh'
  }
  const scopedUser = typeof body.user_email === 'string' && body.user_email ? body.user_email : null
  const force = body.force === true
  // Trigger passthrough: a first-connect dispatch reads every file in full and
  // dates notes to each file's own modified date (Read Me §1); the cron default
  // is a diff-based daily-scan. force is implied by a non-daily trigger.
  const trigger: 'first-connect' | 'daily-scan' | 'forced-refresh' =
    body.trigger === 'first-connect' || body.trigger === 'forced-refresh'
      ? body.trigger
      : 'daily-scan'
  const forceGate = force || trigger !== 'daily-scan'

  const admin = getSupabaseAdmin()

  // Enumerate Drive accounts. channel='drive' keeps this away from gmail rows.
  let q = admin
    .from('sync_state')
    .select('user_email, card_id, last_delta_at')
    .eq('channel', 'drive')
  if (scopedUser) q = q.eq('user_email', scopedUser)
  const { data: rows, error } = await q
  if (error) {
    return NextResponse.json({ error: `sync_state read: ${error.message}` }, { status: 500 })
  }

  const now = Date.now()
  const results: {
    userEmail: string
    card: string
    ran: boolean
    reason: string
    filesIngested?: number
    notesWritten?: number
    error?: string
  }[] = []

  for (const row of rows ?? []) {
    const userEmail = row.user_email as string
    const card = row.card_id as string
    if (!isDriveIngestCard(card)) {
      results.push({ userEmail, card, ran: false, reason: 'not a drive-ingest card' })
      continue
    }

    // Per-user cadence gate: pollHours from that user's card settings.
    if (!forceGate) {
      const state = await getConnectorState(userEmail, card).catch(() => null)
      const pollHours = state?.settings?.pollHours ?? 24
      const last = row.last_delta_at ? new Date(row.last_delta_at as string).getTime() : 0
      const dueAt = last + pollHours * 3600_000
      if (last && now < dueAt) {
        results.push({ userEmail, card, ran: false, reason: `not due (pollHours=${pollHours})` })
        continue
      }
    }

    // Must still have folders selected (user could have disconnected mid-cycle).
    const folders = await getIngestFolders(userEmail, card).catch(() => [])
    if (!folders.length) {
      results.push({ userEmail, card, ran: false, reason: 'no folders selected' })
      continue
    }

    try {
      const report = await runDriveIngest({
        userEmail,
        cardId: card,
        folderIds: folders.map((f) => f.id),
        trigger,
        maxFiles: trigger === 'first-connect' ? 1000 : 500,
      })
      // Stamp the cadence anchor on a successful (or partial) run so the next
      // tick measures from here.
      await admin
        .from('sync_state')
        .update({ last_delta_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('user_email', userEmail)
        .eq('card_id', card)
        .then(() => {}, () => {})

      results.push({
        userEmail,
        card,
        ran: true,
        reason: 'scanned',
        filesIngested: report.filesIngested,
        notesWritten: report.notesWritten,
        ...(report.ok ? {} : { error: report.errors.join('; ').slice(0, 300) }),
      })
    } catch (e) {
      results.push({ userEmail, card, ran: false, reason: 'error', error: (e as Error).message })
    }
  }

  const ranCount = results.filter((r) => r.ran).length
  return NextResponse.json({ ok: true, accounts: results.length, scanned: ranCount, results })
}

// authorization: "Bearer <token>"
function bearer(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

// Constant-time string compare to avoid leaking the secret via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
