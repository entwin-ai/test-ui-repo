import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/whatsapp/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

// The WhatsApp Kanban has exactly TWO columns (Read Me §7), unlike email's three.
// Ignore is never a column — archived entities don't appear on the board at all.
const TIERS = ['updates', 'important'] as const
type Tier = (typeof TIERS)[number]
const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIERS as readonly string[]).includes(v)

/**
 * GET /api/whatsapp/entities
 * WhatsApp Kanban data. Returns every non-archived WhatsApp entity for the user,
 * joined with its classification (tier / confirmed / reason) and the metadata the
 * card shows (type, admin, muted, member count). Archived entities are excluded —
 * they are the Ignore tier and never appear on the board (Read Me §4, §7).
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  // Entities carry the live metadata + archived flag; classifications carry the
  // stored tier/confirmed. We join them in code on identity_key.
  const [{ data: entities, error: eErr }, { data: cls, error: cErr }] = await Promise.all([
    supa
      .from('whatsapp_entity')
      .select(
        'identity_key, wa_entity_type, display_name, muted, member_count, is_admin, archived, community_id, last_seen_at',
      )
      .eq('user_email', auth.email),
    supa
      .from('whatsapp_classification')
      .select('identity_key, tier, confirmed, source, bootstrap_reason, updated_at')
      .eq('user_email', auth.email),
  ])
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })

  const clsByKey = new Map<string, { identity_key: string; tier: string; confirmed: boolean; source: string; bootstrap_reason: string | null; updated_at: string }>(
    (cls || []).map((c: any) => [c.identity_key, c]),
  )

  const items = (entities || [])
    // Exclude archived (Ignore) — not shown on the board (Read Me §4).
    .filter((e: any) => e.archived !== true)
    .map((e: any) => {
      const c = clsByKey.get(e.identity_key)
      // A brand-new 1:1 with no classification row yet is Important by default;
      // a group with none defaults to Updates only if it clearly would be, but
      // we don't recompute rules here — default unknown groups to updates so they
      // surface for review, 1:1s to important (Read Me §7 bootstrap).
      const fallbackTier: Tier = e.wa_entity_type === 'person' ? 'important' : 'updates'
      return {
        identityKey: e.identity_key,
        type: e.wa_entity_type,
        name: e.display_name || e.identity_key,
        tier: (c?.tier as Tier) || fallbackTier,
        confirmed: c?.confirmed ?? false,
        isNew: !(c?.confirmed ?? false),
        reason: c?.bootstrap_reason || null,
        // Card metadata (Read Me §7 "each entity's admin, mute, member-count").
        isAdmin: e.is_admin,
        muted: e.muted,
        memberCount: e.member_count,
        isCommunitySubgroup: !!e.community_id,
      }
    })

  // Group into the two columns for the board.
  return NextResponse.json({
    updates: items.filter((i: { tier: Tier }) => i.tier === 'updates'),
    important: items.filter((i: { tier: Tier }) => i.tier === 'important'),
  })
}

/**
 * PATCH /api/whatsapp/entities  { identityKey, tier?, confirmed?, confirmAll? }
 * Move / confirm entities on the WhatsApp Kanban.
 *   - { identityKey, tier }        move an entity to the other column (manual)
 *   - { identityKey, confirmed }   confirm a provisional bootstrap placement
 *   - { confirmAll: true }         confirm every provisional entity at once
 * A manual move flips source->manual and confirmed->true. An Updates->Important
 * move additionally dispatches the heavy backfill that re-expands past gist days
 * into full facet notes (Read Me §8). Important->Updates needs no backfill —
 * existing notes stand and only new days log as gist.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const body = (await req.json().catch(() => ({}))) as {
    identityKey?: string
    tier?: string
    confirmed?: boolean
    confirmAll?: boolean
  }

  if (body.confirmAll) {
    const { error } = await supa
      .from('whatsapp_classification')
      .update({ confirmed: true, source: 'manual' })
      .eq('user_email', auth.email)
      .eq('confirmed', false)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (!body.identityKey) {
    return NextResponse.json({ error: 'identityKey is required' }, { status: 400 })
  }

  // Read current tier first, to detect an Updates->Important forward move.
  const { data: before } = await supa
    .from('whatsapp_classification')
    .select('tier')
    .eq('user_email', auth.email)
    .eq('identity_key', body.identityKey)
    .maybeSingle()

  const patch: Record<string, unknown> = {}
  if (body.tier !== undefined) {
    if (!isTier(body.tier)) return NextResponse.json({ error: 'invalid tier' }, { status: 400 })
    patch.tier = body.tier
    patch.confirmed = true // a manual move is a confirmation
    patch.source = 'manual'
  }
  if (body.confirmed !== undefined) patch.confirmed = body.confirmed
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  // Upsert: the classification row may not exist yet for a freshly-seen entity
  // the user is moving straight away.
  const { error } = await supa.from('whatsapp_classification').upsert(
    {
      user_email: auth.email,
      card_id: 'whatsapp',
      identity_key: body.identityKey,
      ...patch,
    },
    { onConflict: 'user_email,identity_key' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Updates -> Important forward move: dispatch the re-expansion backfill.
  let backfill: string | null = null
  const movingToImportant = body.tier === 'important'
  const wasUpdates = !before || before.tier === 'updates'
  if (movingToImportant && wasUpdates) {
    const r = await dispatchWorkflow('whatsapp-move-backfill.yml', {
      user_email: auth.email,
      identity_key: body.identityKey,
    })
    if (r.ok) backfill = body.identityKey
  }

  return NextResponse.json({ ok: true, backfill })
}
