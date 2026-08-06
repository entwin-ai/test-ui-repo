import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/notes/[id]/entities
 * The two-field entity display for a Memory Note (v5 §7). Returns, per resolved
 * reference:
 *   - resolved: the entity this note resolved to AT INGESTION (frozen anchor)
 *   - current:  the entity that owns it NOW (redirected by any later merge/split)
 * They agree in the ordinary case; a divergence is the visible trace of a split
 * or merge, not an error. Reads the note_ownership index — never the frozen note.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const { data: rows, error } = await supa
    .from('note_ownership')
    .select('resolved_entity_id, current_entity_id, matched_alias')
    .eq('user_email', auth.email)
    .eq('note_id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const ids = Array.from(
    new Set((rows || []).flatMap((r) => [r.resolved_entity_id, r.current_entity_id])),
  )
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: ents } = await supa
      .from('entity')
      .select('id, canonical_name')
      .eq('user_email', auth.email)
      .in('id', ids)
    for (const e of ents || []) names.set(e.id, e.canonical_name)
  }

  return NextResponse.json({
    references: (rows || []).map((r) => ({
      matchedAlias: r.matched_alias,
      resolved: { id: r.resolved_entity_id, name: names.get(r.resolved_entity_id) || null },
      current: { id: r.current_entity_id, name: names.get(r.current_entity_id) || null },
      diverged: r.resolved_entity_id !== r.current_entity_id,
    })),
  })
}
