import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'
import { reparseEditedScreenplay } from '@/lib/animatics/pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/animatics/approve   { jobId, editedProse? }
 *
 * Final step of Phase 1. If the user edited the screenplay, we re-parse the
 * edited prose back into an updated shot list so the Phase-2 contract stays in
 * sync, then mark the job APPROVED (ready for the video pipeline).
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId, editedProse } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })
  if (!job.screenplayProse) {
    return NextResponse.json({ error: 'No screenplay to approve yet.' }, { status: 400 })
  }

  // If the prose changed, refresh the structured shot list from the edits.
  const finalProse =
    typeof editedProse === 'string' && editedProse.trim() ? editedProse : job.screenplayProse
  const changed = finalProse !== job.screenplayProse

  if (changed) {
    job.screenplayProse = finalProse
    try {
      const refreshed = await reparseEditedScreenplay(auth.email, finalProse, job.characters)
      if (refreshed.length) job.shotList = refreshed
    } catch {
      // Non-fatal: keep the previously generated shot list.
    }
  }

  job.status = 'APPROVED'
  await saveJob(job)

  return NextResponse.json({
    ok: true,
    status: job.status,
    shotCount: job.shotList?.length ?? 0,
    message: 'Screenplay approved. Ready for the Phase 2 video pipeline.',
  })
}
