import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/animatics/worker-auth'
import { claimNextRender, getHeadshot } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/animatics/render/claim   { workerId }
 * Header: x-animatics-worker-token
 *
 * Called by the Colab worker to claim the next queued render job. Returns the
 * full render package: the shot list (from Phase 1), each character's gender
 * (for TTS voice pick) and headshot as a data URL (for VACE reference images +
 * face-swap). Returns { job: null } when the queue is empty.
 */
export async function POST(req: NextRequest) {
  const denied = checkWorker(req)
  if (denied) return denied

  const { workerId } = await req.json().catch(() => ({}))
  const wid = typeof workerId === 'string' && workerId ? workerId : 'colab'

  const job = await claimNextRender(wid)
  if (!job) return NextResponse.json({ job: null })

  // Attach headshots (stored separately per character).
  const characters = []
  for (const c of job.characters) {
    const headshot = await getHeadshot(job.id, c.id)
    characters.push({
      id: c.id,
      name: c.name,
      role: c.role,
      description: c.description,
      // "male"/"female" not tracked in Phase 1 cast; the worker infers a voice
      // from role/name, or the shot list. Send what we have.
      headshot, // data URL or null
      headshotMime: c.headshotMime,
    })
  }

  return NextResponse.json({
    job: {
      id: job.id,
      title: (job.novel.split('\n').find((l) => l.trim()) || 'Untitled').trim().slice(0, 80),
      shotList: job.shotList,
      screenplayProse: job.screenplayProse,
      characters,
    },
  })
}
