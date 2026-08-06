import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

/**
 * POST /api/gmail/confirm-onboarding
 *
 * The user has confirmed sender classification on the Kanban. For every Gmail
 * account of theirs still waiting (onboard_phase = awaiting_confirmation):
 *   1. mark it confirmed, and
 *   2. dispatch the full-history backfill — which now runs against the
 *      CONFIRMED sender lists (Email Ingestion Read Me, Onboarding).
 *
 * Idempotent: accounts not awaiting confirmation are skipped.
 */
export async function POST() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const { data: accts, error } = await supa
    .from('sync_state')
    .select('id, card_id, onboard_phase')
    .eq('user_email', auth.email)
    .eq('channel', 'gmail')
    .eq('onboard_phase', 'awaiting_confirmation')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const dispatched: string[] = []
  for (const a of accts || []) {
    await supa.from('sync_state').update({ onboard_phase: 'confirmed' }).eq('id', a.id)
    const r = await dispatchWorkflow('backfill.yml', { user_email: auth.email, card_id: a.card_id })
    if (r.ok) dispatched.push(a.card_id)
  }

  return NextResponse.json({ ok: true, dispatched })
}
