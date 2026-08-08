import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/whatsapp/route-helpers'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

/**
 * POST /api/babelscribe/transcribe  { drivePath }
 *
 * Babelscribe — multi-lingual audio → English transcript+translation.
 *
 * Takes a Google Drive audio path (share link or bare file id; assumed to have
 * global "anyone with the link" read access) and dispatches the
 * `babelscribe-transcribe` GitHub Actions workflow. The heavy ML work
 * (faster-whisper transcription + translation) runs in Actions, not in this
 * serverless request, so this route just validates the input, extracts the
 * Drive file id, and fires the workflow. Mirrors the WhatsApp-pair /
 * gmail dispatch model already used across the app.
 */

/** Pull a Drive file id out of any of the common Drive URL shapes, or accept a
 *  bare id. Returns null if nothing id-like is found. */
function extractDriveFileId(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  // https://drive.google.com/file/d/<ID>/view?usp=sharing
  let m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/)
  if (m) return m[1]
  // https://drive.google.com/open?id=<ID>  or  ...?id=<ID>&...
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (m) return m[1]
  // https://drive.google.com/uc?export=download&id=<ID>
  // (covered by the id= match above)
  // Bare id pasted on its own.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s
  return null
}

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const { drivePath } = await req.json().catch(() => ({}))
  if (!drivePath || typeof drivePath !== 'string') {
    return NextResponse.json({ error: 'drivePath is required' }, { status: 400 })
  }

  const fileId = extractDriveFileId(drivePath)
  if (!fileId) {
    return NextResponse.json(
      {
        error:
          "Couldn't read a Google Drive file id from that path. Paste the share link (…/file/d/<id>/view) or the bare file id.",
      },
      { status: 400 },
    )
  }

  const repo = process.env.GH_REPO
  const runId = `bscribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const result = await dispatchWorkflow('babelscribe-transcribe.yml', {
    user_email: auth.email,
    drive_file_id: fileId,
    run_id: runId,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: `Could not start transcription: ${result.detail ?? 'dispatch failed'}` },
      { status: 502 },
    )
  }

  const runsUrl = repo ? `https://github.com/${repo}/actions/workflows/babelscribe-transcribe.yml` : null

  return NextResponse.json({
    ok: true,
    fileId,
    runId,
    runsUrl,
    message:
      'Transcription started. Babelscribe is downloading the audio and producing an English transcript (non-English parts kept in brackets). The result PDF will be emailed to you and uploaded as a workflow artifact.',
  })
}
