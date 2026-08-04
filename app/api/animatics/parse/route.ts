import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { cleanNovel, isUsableNovel } from '@/lib/animatics/parse'
import { extractCharacters, NoLlmKeyError } from '@/lib/animatics/pipeline'
import { createJob } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/animatics/parse   (multipart form, field "story" = .txt file)
 *
 * Step 1 of Phase 1: validate the upload is a .txt, strip decorative junk,
 * extract the cast with the user's LLM key, and create a job. Returns the job
 * id + character list so the UI can start collecting headshots.
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

  const story = form.get('story')
  if (!(story instanceof File)) {
    return NextResponse.json({ error: 'No story file provided.' }, { status: 400 })
  }

  // Enforce .txt only — by extension AND by MIME (defense in depth).
  const nameOk = story.name.toLowerCase().endsWith('.txt')
  const typeOk = !story.type || story.type === 'text/plain'
  if (!nameOk || !typeOk) {
    return NextResponse.json(
      { error: 'Only .txt files are accepted. Please upload a plain-text novel.' },
      { status: 400 },
    )
  }

  const rawText = await story.text()
  if (!rawText.trim()) {
    return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 })
  }

  // Core requirement: strip decorative/junk characters, keep meaningful prose.
  const { text: cleaned, stats } = cleanNovel(rawText)
  if (!isUsableNovel(cleaned)) {
    return NextResponse.json(
      {
        error:
          'After removing decorative characters, there was not enough story text to work with. Please upload a fuller novel.',
      },
      { status: 400 },
    )
  }

  try {
    const characters = await extractCharacters(auth.email, cleaned)
    const job = await createJob(
      auth.email,
      cleaned,
      stats as unknown as Record<string, number>,
      characters,
    )
    return NextResponse.json(
      {
        jobId: job.id,
        status: job.status,
        characters: job.characters.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          role: c.role,
          hasHeadshot: false,
        })),
        parseStats: stats,
      },
      { status: 201 },
    )
  } catch (e) {
    if (e instanceof NoLlmKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
