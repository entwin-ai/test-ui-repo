import { NextRequest, NextResponse } from 'next/server'

// Accepts a multipart form with a `story` .txt file.
// This is the entry point for the movie pipeline — here it just validates
// and acknowledges. Wire the body through to your job queue (Supabase row +
// GPU worker) where the actual generation happens asynchronously.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const story = form.get('story')

    if (!(story instanceof File)) {
      return NextResponse.json({ error: 'No story file provided.' }, { status: 400 })
    }
    if (!story.name.toLowerCase().endsWith('.txt')) {
      return NextResponse.json({ error: 'Story must be a .txt file.' }, { status: 400 })
    }

    const text = (await story.text()).trim()
    if (!text) {
      return NextResponse.json({ error: 'Story file is empty.' }, { status: 400 })
    }

    // TODO: enqueue the job (e.g. insert into Supabase `jobs`, upload the
    // story to Storage) and return the job id. For now, acknowledge receipt.
    const jobId = crypto.randomUUID()

    return NextResponse.json(
      { jobId, status: 'queued', chars: text.length },
      { status: 202 }
    )
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Upload failed.' },
      { status: 500 }
    )
  }
}
