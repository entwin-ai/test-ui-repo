import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'
import { generateSegment, segmentNovel, NoLlmKeyError } from '@/lib/animatics/pipeline'
import { buildScreenplayDocx } from '@/lib/animatics/docx'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // allow a few segments per call on supported plans

// How many segments to process per request. Kept small so a single call stays
// well under the function timeout; the client re-calls until done. One segment
// per call is the safest default (a rich segment can take ~30-60s).
const SEGMENTS_PER_CALL = 1

/**
 * POST /api/animatics/screenplay   { jobId }
 *
 * Generates the screenplay INCREMENTALLY so long, multi-episode novels are
 * adapted in full without any single request timing out. Each call processes
 * up to SEGMENTS_PER_CALL segments, persists progress to the job, and returns
 * { done, doneSegments, totalSegments }. The client keeps calling until done.
 *
 * This is the fix for "only the first episode appeared": the novel is split
 * into ordered segments (by Episode/Chapter/Part markers, else by size) and
 * EVERY segment is generated and stitched, instead of truncating the novel to
 * roughly one episode.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  const missing = job.characters.filter((c) => !c.hasHeadshot)
  if (missing.length) {
    return NextResponse.json(
      { error: `Upload a headshot for every character first (${missing.length} remaining).` },
      { status: 400 },
    )
  }

  // Initialize progress on the first call.
  if (!job.progress || job.status !== 'GENERATING') {
    const segs = segmentNovel(job.novel)
    job.progress = {
      totalSegments: segs.length,
      doneSegments: 0,
      proseParts: [],
      shots: [],
      sceneOffset: 0,
    }
    job.status = 'GENERATING'
    await saveJob(job)
  }

  const segments = segmentNovel(job.novel)
  const p = job.progress

  try {
    let processed = 0
    while (p.doneSegments < segments.length && processed < SEGMENTS_PER_CALL) {
      const seg = segments[p.doneSegments]
      const { prose, shots, label, sourceHeading } = await generateSegment(
        auth.email,
        job.characters,
        seg,
        segments.length,
        p.sceneOffset,
        p.shots.length,
      )

      if (prose) {
        // If the source labelled this segment (e.g. "E1: Past Is Prologue"),
        // preserve that exact heading in the screenplay. Synthetic size-split
        // labels ("Part 2") are not injected.
        if (sourceHeading) p.proseParts.push(`\n\n## ${label}\n`)
        p.proseParts.push(prose)
      } else {
        p.proseParts.push(`\n\n[Section "${seg.label}" produced no content and was skipped.]\n`)
      }
      p.shots.push(...shots)
      p.sceneOffset = shots.reduce((m, s) => Math.max(m, s.scene), p.sceneOffset)
      p.doneSegments += 1
      processed += 1
      await saveJob(job) // persist after every segment - resumable on timeout
    }

    const done = p.doneSegments >= segments.length

    if (done) {
      const prose = p.proseParts.join('\n').trim()
      const title = deriveTitle(job.novel)
      const docx = buildScreenplayDocx(`${title} - Screenplay`, prose)
      job.screenplayProse = prose
      job.shotList = p.shots
      job.docxBase64 = docx.toString('base64')
      job.status = 'AWAITING_APPROVAL'
      job.progress = null
      await saveJob(job)

      return NextResponse.json({
        ok: true,
        done: true,
        status: job.status,
        shotCount: p.shots.length,
        segments: segments.length,
        documentUrl: `/api/animatics/document?jobId=${job.id}`,
      })
    }

    return NextResponse.json({
      ok: true,
      done: false,
      status: 'GENERATING',
      doneSegments: p.doneSegments,
      totalSegments: segments.length,
    })
  } catch (e) {
    if (e instanceof NoLlmKeyError) {
      job.status = 'ERROR'
      job.error = e.message
      await saveJob(job)
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    job.error = (e as Error).message
    await saveJob(job)
    return NextResponse.json(
      { error: (e as Error).message, retryable: true, doneSegments: p.doneSegments },
      { status: 500 },
    )
  }
}

/** Use the first non-empty line of the cleaned novel as a title guess. */
function deriveTitle(novel: string): string {
  const first = novel.split('\n').find((l) => l.trim().length > 0)
  return (first || 'Untitled').trim().slice(0, 80)
}
