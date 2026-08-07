import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/entities/review
 * Entity Review dashboard data (v5 §4). Returns every pending_review entity for
 * the signed-in user, enriched with its merge_candidate's name and the count of
 * notes it currently references. Feeds the "Pending Review" section.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const { data: pending, error } = await supa
    .from('entity')
    .select('id, canonical_name, aliases, merge_candidate, merge_score, first_seen')
    .eq('user_email', auth.email)
    .eq('pending_review', true)
    .is('merged_into', null)
    .order('merge_score', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = pending || []
  // Resolve candidate names + reference counts in bulk.
  const candidateIds = Array.from(new Set(rows.map((r) => r.merge_candidate).filter(Boolean)))
  const candidateNames = new Map<string, string>()
  if (candidateIds.length) {
    const { data: cands } = await supa
      .from('entity')
      .select('id, canonical_name')
      .eq('user_email', auth.email)
      .in('id', candidateIds)
    for (const c of cands || []) candidateNames.set(c.id, c.canonical_name)
  }

  // reference count per pending entity
  const counts = new Map<string, number>()
  for (const r of rows) {
    const { count } = await supa
      .from('entity_mention')
      .select('id', { count: 'exact', head: true })
      .eq('user_email', auth.email)
      .eq('entity_id', r.id)
    counts.set(r.id, count || 0)
  }

  return NextResponse.json({
    pending: rows.map((r) => ({
      id: r.id,
      name: r.canonical_name,
      aliases: r.aliases || [],
      candidateId: r.merge_candidate,
      candidateName: r.merge_candidate ? candidateNames.get(r.merge_candidate) || null : null,
      score: r.merge_score != null ? Math.round(Number(r.merge_score) * 100) : null,
      firstSeen: r.first_seen,
      references: counts.get(r.id) || 0,
    })),
  })
}
