import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/whatsapp/route-helpers'
import { getRunState, ghConfigured } from '@/lib/babelscribe/github'

export const dynamic = 'force-dynamic'

/**
 * GET /api/babelscribe/status?runId=<appRunId>
 *
 * Live progress for a dispatched Babelscribe transcription. The frontend polls
 * this while the modal shows "Transcription in-progress", surfacing the current
 * workflow step (e.g. "Transcribe + translate") and, once the run finishes and
 * uploads its artifact, a flag telling the UI the "Transcript Link" is ready.
 */
export async function POST(req: NextRequest) {
  return handle(await req.json().catch(() => ({})))
}

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId') || ''
  return handle({ runId })
}

async function handle(body: { runId?: string }) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 })
  }

  if (!ghConfigured()) {
    return NextResponse.json(
      { error: 'GitHub Actions is not configured (GH_REPO / GH_DISPATCH_TOKEN).' },
      { status: 501 },
    )
  }

  try {
    const state = await getRunState(runId)
    return NextResponse.json({
      ok: true,
      found: state.found,
      status: state.status ?? 'queued',
      conclusion: state.conclusion ?? null,
      phaseLabel: state.phaseLabel,
      artifactReady: state.artifactReady,
      htmlUrl: state.htmlUrl ?? null,
      // Convenience flags for the client state machine.
      done: state.status === 'completed',
      failed: state.status === 'completed' && state.conclusion !== 'success',
    })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read run status: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}
