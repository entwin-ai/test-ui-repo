import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'
import { extractCharacters, NoLlmKeyError } from '@/lib/animatics/pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/animatics/characters   { jobId }
 *
 * Runs character extraction as its OWN step (not inside upload), so the slow
 * LLM call can't time out the upload request. Idempotent and retryable: if the
 * cast is already extracted it just returns it; if a previous attempt failed
 * the client can simply call again.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { jobId } = await req.json().catch(() => ({}))
  if (!jobId) return NextResponse.json({ error: 'jobId required.' }, { status: 400 })

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  // Already extracted — return the existing cast (idempotent).
  if (job.characters.length > 0) {
    return NextResponse.json({
      ok: true,
      status: job.status,
      characters: job.characters.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        role: c.role,
        hasHeadshot: c.hasHeadshot,
      })),
    })
  }

  try {
    const characters = await extractCharacters(auth.email, job.novel)
    if (characters.length === 0) {
      job.status = 'ERROR'
      job.error = 'No characters could be identified in this novel.'
      await saveJob(job)
      return NextResponse.json({ error: job.error }, { status: 422 })
    }
    job.characters = characters
    job.status = 'AWAITING_HEADSHOTS'
    job.error = null
    await saveJob(job)

    return NextResponse.json({
      ok: true,
      status: job.status,
      characters: characters.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        role: c.role,
        hasHeadshot: false,
      })),
    })
  } catch (e) {
    if (e instanceof NoLlmKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    // Leave status as EXTRACTING so the client can retry.
    return NextResponse.json(
      { error: (e as Error).message, retryable: true },
      { status: 500 },
    )
  }
}
