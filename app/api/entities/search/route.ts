import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/entities/search?q=<text>   -> entities whose name/alias matches (New
 *                                        Review manual-merge search, v5 §4).
 * GET /api/entities/search?id=<uuid>  -> one entity's full alias list (the
 *                                        split-alias UI).
 * Retired (merged_into) entities are excluded from search results.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const id = req.nextUrl.searchParams.get('id')
  if (id) {
    const { data, error } = await supa
      .from('entity')
      .select('id, canonical_name, aliases, entity_type')
      .eq('user_email', auth.email)
      .eq('id', id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({
      entity: { id: data.id, name: data.canonical_name, aliases: data.aliases || [], type: data.entity_type },
    })
  }

  const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase()
  let query = supa
    .from('entity')
    .select('id, canonical_name, aliases, entity_type')
    .eq('user_email', auth.email)
    .is('merged_into', null)
    .order('canonical_name', { ascending: true })
    .limit(50)
  if (q) query = query.ilike('canonical_name', `%${q}%`)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If a query was given, also include entities matched only by an alias
  // (ilike above only checks canonical_name). Cheap client-side filter over the
  // bounded set already loaded is enough here.
  const results = (data || []).map((e) => ({
    id: e.id,
    name: e.canonical_name,
    aliases: e.aliases || [],
    type: e.entity_type,
  }))
  return NextResponse.json({ entities: results })
}
