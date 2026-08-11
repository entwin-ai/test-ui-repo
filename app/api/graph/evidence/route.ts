import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { hydrateNotes } from '@/lib/rag/hydrate'

export const dynamic = 'force-dynamic'

/**
 * GET /api/graph/evidence?entityId=<uuid>[&limit=8]
 *
 * Memory-mapping evidence: given an entity (a bubble in the map), return the
 * actual source material behind it — the messages, emails, Slack posts, and
 * document passages that produced the notes mentioning this entity. This is the
 * read-path reuse of the RAG hydration layer: resolve entity -> note_ids via
 * entity_mention, then hydrate those notes to raw source.
 *
 * Hard-scoped to the session email at every hop.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const entityId = req.nextUrl.searchParams.get('entityId')
  if (!entityId) {
    return NextResponse.json({ error: 'entityId required' }, { status: 400 })
  }
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit')) || 8, 1), 20)

  const supa = getSupabaseAdmin()

  // Notes that mention this entity, newest first, user-scoped.
  const { data: mentions, error } = await supa
    .from('entity_mention')
    .select('note_id, memory_note!inner(id, source, note_date, raw_summary)')
    .eq('user_email', auth.email) // HARD scope
    .eq('entity_id', entityId)
    .order('note_date', { referencedTable: 'memory_note', ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const notes = (mentions || [])
    .map((m: any) => m.memory_note)
    .filter(Boolean)
  const noteIds = notes.map((n: any) => n.id)

  const hydrated = await hydrateNotes(auth.email, noteIds)

  return NextResponse.json({
    entityId,
    evidence: notes.map((n: any) => {
      const h = hydrated.get(n.id)
      return {
        noteId: n.id,
        source: n.source,
        date: n.note_date,
        summary: n.raw_summary,
        excerpt: h?.excerpt ?? null, // verbatim source, when available
      }
    }),
  })
}
