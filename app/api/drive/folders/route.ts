import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveCard } from '@/lib/drive/route-helpers'
import { listFolders } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/drive/folders?card=chorale-recorder&parent=root
 * Lists the folders immediately inside `parent` (defaults to "root" = My Drive)
 * for the Drive Explorer. Requires a connected Drive session for the card
 * (established by the authorize/callback flow).
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const card = req.nextUrl.searchParams.get('card')
  if (!isDriveCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing card id' }, { status: 400 })
  }
  const parent = req.nextUrl.searchParams.get('parent') || 'root'

  try {
    const folders = await listFolders(auth.email, card, parent)
    return NextResponse.json({ folders })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
