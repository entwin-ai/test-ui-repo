import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/usage
 *
 * Everything the Dashboard needs for the signed-in user, hard-scoped by session
 * email. Two families of numbers:
 *
 *   1. Token usage from llm_cost_log (input/output totals + per-call-kind).
 *   2. Real ingestion metrics that used to be hardcoded placeholders:
 *        - notesIndexed        : count of memory_note rows (Memory Notes written)
 *        - preferencesLearned  : count of entity rows (canonical people/orgs the
 *                                twin has learned — the personalization surface)
 *        - last-7-day ingestion tiers, derived from daily_rollup (ignore /
 *          storage/"updates") and memory_note (memory-worthy), not demo numbers.
 *        - entitiesThisWeek    : entity rows created in the last 7 days.
 *
 * Counts use head:true count queries (no rows shipped). Any single count that
 * errors degrades to null so one failure never blanks the whole dashboard.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const supa = getSupabaseAdmin()
  const email = auth.email

  // ---- 1. Token usage (unchanged shape) ----
  const { data, error } = await supa
    .from('llm_cost_log')
    .select('call_kind, input_tokens, output_tokens')
    .eq('user_email', email)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let inputTokens = 0
  let outputTokens = 0
  let calls = 0
  const byKind: Record<string, { calls: number; input: number; output: number }> = {}
  for (const r of data || []) {
    const inp = r.input_tokens || 0
    const out = r.output_tokens || 0
    inputTokens += inp
    outputTokens += out
    calls += 1
    const k = r.call_kind || 'unknown'
    if (!byKind[k]) byKind[k] = { calls: 0, input: 0, output: 0 }
    byKind[k].calls += 1
    byKind[k].input += inp
    byKind[k].output += out
  }

  // ---- 2. Real ingestion metrics ----
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const sevenDaysAgoDate = sevenDaysAgo.toISOString().slice(0, 10) // YYYY-MM-DD
  const sevenDaysAgoTs = sevenDaysAgo.toISOString()

  // A guarded head-count helper: returns the count or null on error.
  async function countOf(build: () => any): Promise<number | null> {
    try {
      const { count, error } = await build()
      if (error) return null
      return count ?? 0
    } catch {
      return null
    }
  }

  // Sum entry_count across daily_rollup rows of given kind(s), last 7 days.
  async function rollupSum(kinds: string[]): Promise<number | null> {
    try {
      const { data, error } = await supa
        .from('daily_rollup')
        .select('entry_count')
        .eq('user_email', email)
        .in('kind', kinds)
        .gte('rollup_date', sevenDaysAgoDate)
      if (error) return null
      return (data || []).reduce((n, r) => n + (r.entry_count || 0), 0)
    } catch {
      return null
    }
  }

  const [
    notesIndexed,
    preferencesLearned,
    memoryWorthy7d,
    entitiesThisWeek,
    ignoreTier7d,
    storageTier7d,
  ] = await Promise.all([
    countOf(() =>
      supa.from('memory_note').select('*', { count: 'exact', head: true }).eq('user_email', email),
    ),
    countOf(() =>
      supa.from('entity').select('*', { count: 'exact', head: true }).eq('user_email', email),
    ),
    countOf(() =>
      supa
        .from('memory_note')
        .select('*', { count: 'exact', head: true })
        .eq('user_email', email)
        .gte('created_at', sevenDaysAgoTs),
    ),
    countOf(() =>
      supa
        .from('entity')
        .select('*', { count: 'exact', head: true })
        .eq('user_email', email)
        .gte('created_at', sevenDaysAgoTs),
    ),
    rollupSum(['ignored']),
    rollupSum(['updates', 'wa_updates']),
  ])

  return NextResponse.json({
    inputTokens,
    outputTokens,
    calls,
    byKind,
    // real metrics (null = couldn't be read this cycle)
    notesIndexed,
    preferencesLearned,
    ingestion7d: {
      ignore: ignoreTier7d,
      storage: storageTier7d,
      memoryWorthy: memoryWorthy7d,
    },
    entitiesThisWeek,
  })
}
