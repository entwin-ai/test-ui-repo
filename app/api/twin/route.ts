import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { killTwin } from '@/lib/twin/teardown'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/twin
 *
 * "Kill My Twin" — permanently deletes EVERYTHING Entwin holds for the
 * signed-in user: LLM API key, every connector's settings, all ingested data
 * across every channel, all derived memory/entities/rollups/cost logs, and the
 * sync_state rows that schedule their GitHub Actions processing. Irreversible.
 *
 * The user_email is taken from the session — never from the request — so a user
 * can only ever kill their own twin.
 */
export async function DELETE() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  try {
    const report = await killTwin(auth.email)
    // 200 when everything cleared; 207 (Multi-Status) if some steps failed so
    // the client can surface a partial-failure message and offer a retry.
    return NextResponse.json(report, { status: report.ok ? 200 : 207 })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    )
  }
}
