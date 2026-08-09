import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { selectFolderByUrl } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/select-url
 * Body: { card, folderUrl }
 *
 * Backs the Chorale "Configure GDrive" flow: the user pastes a Google Drive URL
 * that points to a (shared-drive) folder Entwin should write recordings into.
 * We extract the folder id, verify Entwin has WRITE access to it, and persist it
 * as the card's destination folder.
 *
 * If the card has no connected Drive write token yet, we DON'T fail — we reply
 * with { needsAuth: true }, and the client hands the user off to
 * /api/drive/authorize (carrying the URL through the signed OAuth state) so the
 * same folder is auto-saved once consent is granted.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = (await req.json().catch(() => ({}))) as {
    card?: string
    folderUrl?: string
  }
  if (!isDriveCard(body.card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  if (!body.folderUrl || !body.folderUrl.trim()) {
    return NextResponse.json({ error: 'folderUrl is required' }, { status: 400 })
  }

  try {
    const result = await selectFolderByUrl(auth.email, body.card, body.folderUrl.trim())
    if (result.needsAuth) {
      return NextResponse.json({ ok: false, needsAuth: true })
    }
    return NextResponse.json({ ok: true, selectedFolder: result.selectedFolder })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
