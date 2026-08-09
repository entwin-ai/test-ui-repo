import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/whatsapp/route-helpers'
import { getTranscriptPdf, ghConfigured } from '@/lib/babelscribe/github'

export const dynamic = 'force-dynamic'

/**
 * GET /api/babelscribe/transcript?runId=<appRunId>
 *
 * Fetches the finished Babelscribe artifact zip from GitHub Actions, extracts
 * transcript.pdf in-memory, and streams it back with download headers. This is
 * what the modal's "Transcript Link" points at — clicking it saves the PDF
 * locally.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const runId = (req.nextUrl.searchParams.get('runId') || '').trim()
  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 })
  }

  if (!ghConfigured()) {
    return NextResponse.json(
      { error: 'GitHub Actions is not configured (GH_REPO / GH_DISPATCH_TOKEN).' },
      { status: 501 },
    )
  }

  let result: { bytes: Buffer; filename: string } | null
  try {
    result = await getTranscriptPdf(runId)
  } catch (e) {
    return NextResponse.json(
      { error: `Could not retrieve transcript: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  if (!result) {
    return NextResponse.json(
      { error: 'Transcript is not ready yet, or no PDF was found in the artifact.' },
      { status: 404 },
    )
  }

  // Convert the Node Buffer to a fresh ArrayBuffer for the Web Response body.
  const ab = result.bytes.buffer.slice(
    result.bytes.byteOffset,
    result.bytes.byteOffset + result.bytes.byteLength,
  ) as ArrayBuffer

  return new NextResponse(ab, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.bytes.byteLength),
      'Cache-Control': 'no-store',
    },
  })
}
