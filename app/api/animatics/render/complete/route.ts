import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/animatics/worker-auth'
import { getJob, saveJob } from '@/lib/animatics/store'
import { sendVideoReadyEmail } from '@/lib/animatics/email'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/animatics/render/complete
 *   { jobId, driveLink, driveFileId?, failure? }
 * Header: x-animatics-worker-token
 *
 * The Colab worker calls this when the MP4 is uploaded to Drive (success) or
 * when rendering failed. On success we record the link, mark RENDER_DONE, and
 * email the link to the job owner. On failure we mark RENDER_FAILED.
 */
export async function POST(req: NextRequest) {
  const denied = checkWorker(req)
  if (denied) return denied

  const { jobId, driveLink, driveFileId, failure } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getJob(jobId)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })
  if (!job.render) {
    return NextResponse.json({ error: 'Job is not in a render state.' }, { status: 400 })
  }

  // Failure path.
  if (failure || !driveLink) {
    job.status = 'RENDER_FAILED'
    job.render.failure = String(failure || 'Worker reported no Drive link.').slice(0, 500)
    await saveJob(job)
    return NextResponse.json({ ok: true, status: 'RENDER_FAILED' })
  }

  // Success path.
  job.render.driveLink = String(driveLink)
  job.render.driveFileId = driveFileId ? String(driveFileId) : null
  job.render.progress = 'done'
  job.status = 'RENDER_DONE'
  await saveJob(job)

  // Email the link to the owner (best-effort; the link is also shown in-app).
  const title = (job.novel.split('\n').find((l) => l.trim()) || 'Untitled').trim().slice(0, 80)
  const emailResult = await sendVideoReadyEmail({
    to: job.owner,
    title,
    driveLink: job.render.driveLink,
  })
  if (emailResult.sent) {
    job.render.emailedAt = Date.now()
    await saveJob(job)
  }

  return NextResponse.json({
    ok: true,
    status: 'RENDER_DONE',
    emailed: emailResult.sent,
    emailReason: emailResult.sent ? undefined : emailResult.reason,
  })
}
