import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { uploadRecordingToSelectedFolder } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'
// Allow larger request bodies for audio uploads.
export const maxDuration = 60

/**
 * POST /api/drive/upload-recording   (multipart/form-data)
 *   fields: card=<drive card id>, file=<recorded audio blob>
 *
 * Persists a finished Chorale recording (captured in-browser from tab/system
 * audio) into the card's configured Google Drive folder using the granted write
 * token. Returns the created Drive file id + view link.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const card = form.get('card')
  if (!isDriveCard(typeof card === 'string' ? card : undefined)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }

  const mimeType = file.type || 'audio/webm'
  // Prefer the client-provided name; fall back to a timestamped default.
  const nameField = form.get('name')
  const name =
    (typeof nameField === 'string' && nameField.trim()) ||
    file.name ||
    `chorale-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`

  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length === 0) {
      return NextResponse.json({ error: 'Recording is empty' }, { status: 400 })
    }
    const uploaded = await uploadRecordingToSelectedFolder(auth.email, card as string, {
      name,
      mimeType,
      bytes,
    })
    return NextResponse.json({ ok: true, file: uploaded })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
