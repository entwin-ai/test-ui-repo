import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { cleanNovel, isUsableNovel } from '@/lib/animatics/parse'
import { createJob } from '@/lib/animatics/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/anime/upload   (multipart form, field "story" = .txt file)
 *
 * Thin, real entry point for the movie pipeline. This used to mint a throwaway
 * job id with a "TODO: enqueue" and acknowledge without doing anything — it is
 * now wired to the SAME pipeline the Animatics UI uses (/api/animatics/parse):
 * validate the .txt, strip decorative junk, and create a real job in Redis in
 * EXTRACTING state. Character extraction is the next, separate step
 * (POST /api/animatics/characters), so this request stays fast and never times
 * out.
 *
 * Kept as an alias so any existing caller of this path does the right thing;
 * new integrations should prefer /api/animatics/parse directly.
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
  const nameOk = story.name.toLowerCase().endsWith('.txt')
  const typeOk = !story.type || story.type === 'text/plain'
  if (!nameOk || !typeOk) {
    return NextResponse.json(
      { error: 'Only .txt files are accepted. Please upload a plain-text story.' },
      { status: 400 },
    )
  }

  const rawText = await story.text()
  if (!rawText.trim()) {
    return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 })
  }

  const { text: cleaned, stats } = cleanNovel(rawText)
  if (!isUsableNovel(cleaned)) {
    return NextResponse.json(
      {
        error:
          'After removing decorative characters, there was not enough story text to work with. Please upload a fuller story.',
      },
      { status: 400 },
    )
  }

  try {
    const job = await createJob(
      auth.email,
      cleaned,
      stats as unknown as Record<string, number>,
      [],
    )
    // 202 Accepted: the job is created and queued for the next pipeline step.
    return NextResponse.json(
      { jobId: job.id, status: job.status, parseStats: stats, chars: cleaned.length },
      { status: 202 },
    )
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
