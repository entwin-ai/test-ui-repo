import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, enqueueRender } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/animatics/render   { jobId }
 *
 * User-facing: queue an APPROVED screenplay for Phase 2 video rendering. The
 * job goes onto the render queue; a Colab worker will claim it. Idempotent —
 * re-queuing a job already queued/rendering is a no-op.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  if (!job.shotList || job.shotList.length === 0) {
    return NextResponse.json(
      { error: 'This job has no shot list to render. Approve a screenplay first.' },
      { status: 400 },
    )
  }
  if (job.status === 'RENDER_QUEUED' || job.status === 'RENDERING') {
    return NextResponse.json({ ok: true, status: job.status, alreadyQueued: true })
  }
  if (job.status !== 'APPROVED' && job.status !== 'RENDER_FAILED' && job.status !== 'RENDER_DONE') {
    return NextResponse.json(
      { error: 'Approve the screenplay before rendering.' },
      { status: 400 },
    )
  }

  await enqueueRender(job)
  return NextResponse.json({ ok: true, status: 'RENDER_QUEUED' })
}
