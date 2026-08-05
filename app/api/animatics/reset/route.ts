import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, getLatestJobId, deleteJob } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/animatics/reset   { jobId? }
 *
 * Disconnect / forget-last-run. Deletes the job (blob + headshots + owner
 * index) so the next run starts completely fresh from step 1, regardless of
 * which stage it was at. If no jobId is given, resolves the caller's latest
 * job. Idempotent: succeeds even if there's nothing to delete.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({}))
  let jobId: string | null = typeof body?.jobId === 'string' ? body.jobId : null
  if (!jobId) jobId = await getLatestJobId(auth.email)

  if (!jobId) {
    // Nothing to reset — treat as success so the UI can always go back to start.
    return NextResponse.json({ ok: true, deleted: false })
  }

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) {
    // Not found or not owned — nothing to delete for this user.
    return NextResponse.json({ ok: true, deleted: false })
  }

  await deleteJob(job)
  return NextResponse.json({ ok: true, deleted: true })
}
