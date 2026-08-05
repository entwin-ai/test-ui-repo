import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/animatics/worker-auth'
import { getJob, saveJob } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/animatics/render/progress   { jobId, progress }
 * Header: x-animatics-worker-token
 *
 * The Colab worker reports free-text progress (e.g. "audio 3/12", "video 7/12",
 * "face-swap", "uploading"). Stored so the user's status view can show it.
 */
export async function POST(req: NextRequest) {
  const denied = checkWorker(req)
  if (denied) return denied

  const { jobId, progress } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getJob(jobId)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })
  if (job.render) job.render.progress = String(progress || '').slice(0, 200)
  await saveJob(job)
  return NextResponse.json({ ok: true })
}
