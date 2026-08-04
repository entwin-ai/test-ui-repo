import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'
import { buildScreenplayDocx } from '@/lib/animatics/docx'

export const dynamic = 'force-dynamic'

/**
 * GET /api/animatics/document?jobId=...
 * Streams the generated .docx for download/review.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const jobId = req.nextUrl.searchParams.get('jobId') || ''
  const job = await getOwnedJob(jobId, auth.email)
  if (!job || !job.docxBase64) {
    return NextResponse.json({ error: 'Document not ready.' }, { status: 404 })
  }

  const buf = Buffer.from(job.docxBase64, 'base64')
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="animatics-screenplay-${job.id.slice(0, 8)}.docx"`,
    },
  })
}

/**
 * POST /api/animatics/document   { jobId, prose }
 * Saves an edited screenplay (plain text the user pasted/edited) and rebuilds
 * the .docx so the download reflects their changes. Keeps status at
 * AWAITING_APPROVAL.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId, prose } = await req.json().catch(() => ({}))
  if (!jobId || typeof prose !== 'string') {
    return NextResponse.json({ error: 'jobId and prose are required.' }, { status: 400 })
  }

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  const title = (job.novel.split('\n').find((l) => l.trim()) || 'Untitled').trim().slice(0, 80)
  job.screenplayProse = prose
  job.docxBase64 = buildScreenplayDocx(`${title} — Screenplay`, prose).toString('base64')
  job.status = 'AWAITING_APPROVAL'
  await saveJob(job)

  return NextResponse.json({ ok: true, status: job.status })
}
