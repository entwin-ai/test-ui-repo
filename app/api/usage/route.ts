import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/usage
 * Returns total input/output tokens the LLM has used for the signed-in user,
 * plus a per-call-kind breakdown. Read from llm_cost_log (one row per LLM call).
 * user_email from the session; hard-scoped to it.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const supa = getSupabaseAdmin()
  // Pull the rows for this user and aggregate in JS (simple + avoids a custom
  // SQL function; the table is small — one row per LLM call).
  const { data, error } = await supa
    .from('llm_cost_log')
    .select('call_kind, input_tokens, output_tokens')
    .eq('user_email', auth.email)
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

  return NextResponse.json({ inputTokens, outputTokens, calls, byKind })
}
