import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getOwnedJob, saveJob } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

/**
 * POST /api/animatics/headshot   (multipart: jobId, characterId, image)
 *
 * Attaches an uploaded headshot to one character. When every character has a
 * headshot, the job flips to AWAITING_HEADSHOTS→(ready for screenplay).
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a multipart form upload.' }, { status: 400 })
  }

  const jobId = String(form.get('jobId') || '')
  const characterId = String(form.get('characterId') || '')
  const image = form.get('image')

  if (!jobId || !characterId) {
    return NextResponse.json({ error: 'jobId and characterId are required.' }, { status: 400 })
  }
  if (!(image instanceof File)) {
    return NextResponse.json({ error: 'No image provided.' }, { status: 400 })
  }
  if (!ALLOWED_IMAGE.includes(image.type)) {
    return NextResponse.json(
      { error: 'Headshot must be a PNG, JPEG, or WebP image.' },
      { status: 400 },
    )
  }
  const bytes = Buffer.from(await image.arrayBuffer())
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ error: 'Headshot must be under 5 MB.' }, { status: 400 })
  }

  const job = await getOwnedJob(jobId, auth.email)
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })

  const character = job.characters.find((c) => c.id === characterId)
  if (!character) return NextResponse.json({ error: 'Character not found.' }, { status: 404 })

  character.headshot = `data:${image.type};base64,${bytes.toString('base64')}`
  character.headshotMime = image.type

  const allHaveHeadshots = job.characters.every((c) => c.headshot)
  job.status = allHaveHeadshots ? 'PARSED' : 'AWAITING_HEADSHOTS'
  // PARSED here means "ready to generate" — all headshots collected.

  await saveJob(job)

  return NextResponse.json({
    ok: true,
    status: job.status,
    readyForScreenplay: allHaveHeadshots,
    characters: job.characters.map((c) => ({ id: c.id, hasHeadshot: !!c.headshot })),
  })
}
