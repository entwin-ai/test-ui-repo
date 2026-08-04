import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'
import { generateScreenplay, NoLlmKeyError } from '@/lib/animatics/pipeline'
import { buildScreenplayDocx } from '@/lib/animatics/docx'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/animatics/screenplay   { jobId }
 *
 * Step 3: requires every character to have a headshot. Generates the vivid
 * screenplay prose + structured shot list in one LLM pass, builds the .docx,
 * and moves the job to AWAITING_APPROVAL.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  const missing = job.characters.filter((c) => !c.headshot)
  if (missing.length) {
    return NextResponse.json(
      { error: `Upload a headshot for every character first (${missing.length} remaining).` },
      { status: 400 },
    )
  }

  job.status = 'GENERATING'
  await saveJob(job)

  try {
    const { prose, shots } = await generateScreenplay(auth.email, job.novel, job.characters)
    const title = deriveTitle(job.novel)
    const docx = buildScreenplayDocx(`${title} — Screenplay`, prose)

    job.screenplayProse = prose
    job.shotList = shots
    job.docxBase64 = docx.toString('base64')
    job.status = 'AWAITING_APPROVAL'
    await saveJob(job)

    return NextResponse.json({
      ok: true,
      status: job.status,
      shotCount: shots.length,
      documentUrl: `/api/animatics/document?jobId=${job.id}`,
    })
  } catch (e) {
    job.status = 'ERROR'
    job.error = (e as Error).message
    await saveJob(job)
    if (e instanceof NoLlmKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/** Use the first non-empty line of the cleaned novel as a title guess. */
function deriveTitle(novel: string): string {
  const first = novel.split('\n').find((l) => l.trim().length > 0)
  return (first || 'Untitled').trim().slice(0, 80)
}
