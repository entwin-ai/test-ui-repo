import { NextRequest, NextResponse } from 'next/server'
import { requireUser, isDriveIngestCard } from '@/lib/drive/route-helpers'
import { setIngestFolders, getIngestFolders } from '@/lib/drive/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/drive/select-ingest
 * Body: { card, folders: [{ id, name, path }], mode?: "replace" | "add" }
 *
 * Persists the folder(s) the user chose as ingestion roots for a Drive-ingest
 * card (Read Me §1 Scope — only selected folders are ever read). Unlike
 * Chorale's single destination folder, an ingest card can watch several folders
 * (a My Drive subtree plus a Shared Drive folder, …). `mode: "add"` appends to
 * the existing selection; the default replaces it.
 *
 * GET /api/drive/select-ingest?card=drive-personal returns the current
 * selection so the UI can show what's being watched.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = (await req.json().catch(() => ({}))) as {
    card?: string
    folders?: { id?: string; name?: string; path?: string }[]
    mode?: 'replace' | 'add'
  }
  if (!isDriveIngestCard(body.card)) {
    return NextResponse.json({ error: 'Invalid or missing Drive ingest card id' }, { status: 400 })
  }
  const incoming = (body.folders || [])
    .filter((f) => f && f.id && f.name)
    .map((f) => ({ id: f.id as string, name: f.name as string, path: f.path || (f.name as string) }))
  if (!incoming.length) {
    return NextResponse.json({ error: 'At least one folder (id + name) is required' }, { status: 400 })
  }

  try {
    let folders = incoming
    if (body.mode === 'add') {
      const existing = await getIngestFolders(auth.email, body.card)
      const byId = new Map(existing.map((f) => [f.id, f]))
      for (const f of incoming) byId.set(f.id, f)
      folders = [...byId.values()]
    }
    await setIngestFolders(auth.email, body.card, folders)
    return NextResponse.json({ ok: true, folders })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const card = req.nextUrl.searchParams.get('card')
  if (!isDriveIngestCard(card)) {
    return NextResponse.json({ error: 'Invalid or missing Drive ingest card id' }, { status: 400 })
  }
  try {
    const folders = await getIngestFolders(auth.email, card)
    return NextResponse.json({ folders })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
