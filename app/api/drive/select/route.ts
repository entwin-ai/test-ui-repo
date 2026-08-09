import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { selectFolder } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/select
 * Body: { card, folderId, folderName, folderPath }
 * Persists the user's chosen destination folder onto the Drive session for the
 * card so Chorale recordings can be written there.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = (await req.json().catch(() => ({}))) as {
    card?: string
    folderId?: string
    folderName?: string
    folderPath?: string
  }
  if (!isDriveCard(body.card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  if (!body.folderId || !body.folderName) {
    return NextResponse.json({ error: 'folderId and folderName are required' }, { status: 400 })
  }

  try {
    await selectFolder(auth.email, body.card, {
      id: body.folderId,
      name: body.folderName,
      path: body.folderPath || body.folderName,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
