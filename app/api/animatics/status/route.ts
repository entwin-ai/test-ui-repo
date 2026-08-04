import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, getJob, getLatestJobId } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'

/**
 * GET /api/animatics/status[?jobId=...]
 *
 * Returns the current pipeline state. With no jobId, resolves the caller's most
 * recent job so the connector card can restore its place after a page reload.
 * Never returns headshot bytes or the docx blob — only lightweight state.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  let jobId = req.nextUrl.searchParams.get('jobId') || ''
  if (!jobId) {
    const latest = await getLatestJobId(auth.email)
    if (!latest) return NextResponse.json({ job: null })
    jobId = latest
  }

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ job: null })

  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      characters: job.characters.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        role: c.role,
        hasHeadshot: c.hasHeadshot,
      })),
      hasScreenplay: !!job.screenplayProse,
      screenplayProse: job.screenplayProse,
      shotCount: job.shotList?.length ?? 0,
      generation: job.progress
        ? { done: job.progress.doneSegments, total: job.progress.totalSegments }
        : null,
      parseStats: job.parseStats,
      documentUrl: job.docxBase64 ? `/api/animatics/document?jobId=${job.id}` : null,
      error: job.error,
    },
  })
}
