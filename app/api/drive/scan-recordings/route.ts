import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { scanRecordings, markRecordingsDispatched, status } from '@/lib/drive/service'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/scan-recordings   { card }
 *
 * Watches the configured Google Drive folder (the Meet Recordings folder) for
 * NEW native Meet recording media and hands each new file to Babelscribe for
 * transcription — the same `babelscribe-transcribe.yml` workflow the manual
 * Babelscribe card uses. Idempotent: files already dispatched are skipped on
 * subsequent scans.
 *
 * Intended to be called either on demand (a Chorale "Check for recordings"
 * action) or on a schedule (a cron / GitHub Action), so recordings are picked
 * up shortly after Meet finishes writing them to Drive.
 *
 * Only runs when the recorder is armed ("Turn-on Recorder"). A disarmed card
 * returns skipped:true without scanning.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = (await req.json().catch(() => ({}))) as { card?: string }
  if (!isDriveCard(body.card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  const card = body.card

  try {
    const s = await status(auth.email, card)
    if (!s.recorderArmed) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'Recorder is off' })
    }

    const scan = await scanRecordings(auth.email, card)
    if (scan.newRecordings.length === 0) {
      return NextResponse.json({
        ok: true,
        dispatched: 0,
        totalSeen: scan.totalSeen,
        folderName: scan.folderName,
      })
    }

    // Dispatch each new recording to Babelscribe. Only mark as seen the ones
    // that dispatched cleanly, so a transient failure is retried next scan.
    const dispatchedIds: string[] = []
    const failures: { id: string; name: string; detail?: string }[] = []
    for (const rec of scan.newRecordings) {
      const runId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const result = await dispatchWorkflow('babelscribe-transcribe.yml', {
        user_email: auth.email,
        drive_file_id: rec.id,
        run_id: runId,
      })
      if (result.ok) {
        dispatchedIds.push(rec.id)
      } else {
        failures.push({ id: rec.id, name: rec.name, detail: result.detail })
      }
    }

    await markRecordingsDispatched(auth.email, card, dispatchedIds)

    return NextResponse.json({
      ok: true,
      dispatched: dispatchedIds.length,
      failed: failures.length,
      failures,
      totalSeen: scan.totalSeen,
      folderName: scan.folderName,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
