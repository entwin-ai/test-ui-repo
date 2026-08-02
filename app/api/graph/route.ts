import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/graph
 * Returns the relationship graph for the signed-in user: nodes (entities with
 * bubble size) and edges (co-occurrence in the same Memory Note). Built entirely
 * from existing data via the entity layer — no email content duplicated.
 * user_email comes from the session; both RPCs are hard-scoped to it.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const supa = getSupabaseAdmin()
  const [{ data: nodes, error: nErr }, { data: edges, error: eErr }] = await Promise.all([
    supa.rpc('entity_graph_nodes', { p_user_email: auth.email }),
    supa.rpc('entity_graph_edges', { p_user_email: auth.email }),
  ])
  if (nErr) return NextResponse.json({ error: nErr.message }, { status: 500 })
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })

  return NextResponse.json({
    nodes: (nodes || []).map((n: any) => ({
      id: n.entity_id,
      name: n.canonical_name,
      type: n.entity_type,
      size: Number(n.bubble_size) || 0,
      firstSeen: n.first_seen,
      lastSeen: n.last_seen,
    })),
    edges: (edges || []).map((e: any) => ({
      source: e.source_id,
      target: e.target_id,
      weight: Number(e.weight) || 1,
    })),
  })
}
