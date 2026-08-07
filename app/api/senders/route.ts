import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

const LISTS = ['marketing', 'updates', 'people'] as const
type List = (typeof LISTS)[number]
const isList = (v: unknown): v is List => typeof v === 'string' && (LISTS as readonly string[]).includes(v)

/**
 * GET /api/senders
 * The sender-classification Kanban data. Returns every classified sender for the
 * user, each with its list, whether it's confirmed, and any entity tag — so the
 * board can render three columns and highlight unconfirmed (new) senders.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const { data, error } = await supa
    .from('sender_classification')
    .select('id, sender_address, list, confirmed, source, entity_id, bootstrap_reason, updated_at')
    .eq('user_email', auth.email)
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    senders: (data || []).map((s) => ({
      id: s.id,
      address: s.sender_address,
      list: s.list,
      confirmed: s.confirmed,
      isNew: !s.confirmed, // unconfirmed => highlighted as "new" on the board
      entityId: s.entity_id,
      reason: s.bootstrap_reason,
    })),
  })
}

/**
 * PATCH /api/senders  { id?, address?, list?, confirmed?, entityId? }
 * Reclassify / confirm one sender, or confirm all at once.
 *   - { id, list }            move a sender to another list (marks it confirmed)
 *   - { id, confirmed:true }  confirm a single provisional sender
 *   - { id, entityId }        set/clear the dual-classification entity tag
 *   - { confirmAll:true }     confirm every provisional sender (onboarding)
 * A move is user-initiated, so it always flips source->manual and confirmed->true.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const body = (await req.json().catch(() => ({}))) as {
    id?: string
    list?: string
    confirmed?: boolean
    entityId?: string | null
    confirmAll?: boolean
  }

  if (body.confirmAll) {
    const { error } = await supa
      .from('sender_classification')
      .update({ confirmed: true, source: 'manual' })
      .eq('user_email', auth.email)
      .eq('confirmed', false)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Read the sender's current state first — needed to detect a forward move that
  // triggers a backfill (Marketing -> People / Marketing -> Updates).
  const { data: before } = await supa
    .from('sender_classification')
    .select('sender_address, list')
    .eq('user_email', auth.email)
    .eq('id', body.id)
    .maybeSingle()

  const patch: Record<string, unknown> = {}
  if (body.list !== undefined) {
    if (!isList(body.list)) return NextResponse.json({ error: 'invalid list' }, { status: 400 })
    patch.list = body.list
    patch.confirmed = true // a manual move is a confirmation
    patch.source = 'manual'
  }
  if (body.confirmed !== undefined) patch.confirmed = body.confirmed
  if (body.entityId !== undefined) patch.entity_id = body.entityId // null clears the tag
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const { error } = await supa
    .from('sender_classification')
    .update(patch)
    .eq('user_email', auth.email)
    .eq('id', body.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Forward-move backfill (Email Ingestion Read Me, the two confirmed rows):
  // moving a sender to a richer tier reprocesses its history at the new shape.
  // Marketing -> People and Marketing -> Updates qualify. Moves to a lighter
  // tier never delete and need no backfill. Best-effort dispatch.
  let backfill: string | null = null
  if (before && body.list && before.list === 'marketing' && (body.list === 'people' || body.list === 'updates')) {
    const r = await dispatchWorkflow('sender-backfill.yml', {
      user_email: auth.email,
      sender: before.sender_address,
    })
    if (r.ok) backfill = before.sender_address
  }

  return NextResponse.json({ ok: true, backfill })
}
