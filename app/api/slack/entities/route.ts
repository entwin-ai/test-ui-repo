import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/slack/route-helpers'
import { getSupabaseAdmin } from '@/lib/rag/supabase'
import { dispatchWorkflow } from '@/lib/gmail/dispatch'

export const dynamic = 'force-dynamic'

// The Slack Kanban has exactly TWO columns (Read Me §8), like WhatsApp's. Ignore
// is never a column — archived entities don't appear on the board at all
// (Read Me §4).
const TIERS = ['updates', 'important'] as const
type Tier = (typeof TIERS)[number]
const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIERS as readonly string[]).includes(v)

const CARD_ID = 'slack-workspace'

/**
 * GET /api/slack/entities
 * Slack Kanban data. Returns every non-archived Slack entity for the user,
 * joined with its classification (tier / confirmed / reason) and the card
 * metadata (type, external shape). Archived entities are excluded — they are the
 * Ignore tier and never appear (Read Me §4, §8).
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error
  const supa = getSupabaseAdmin()

  const [{ data: entities, error: eErr }, { data: cls, error: cErr }] = await Promise.all([
    supa
      .from('slack_entity')
      .select(
        'identity_key, slack_entity_type, display_name, archived, external_shape, external_org_id, last_seen_at',
      )
      .eq('user_email', auth.email)
      .eq('card_id', CARD_ID),
    supa
      .from('slack_classification')
      .select('identity_key, tier, confirmed, source, bootstrap_reason, updated_at')
      .eq('user_email', auth.email)
      .eq('card_id', CARD_ID),
  ])
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })

  const clsByKey = new Map<string, { tier: string; confirmed: boolean; source: string; bootstrap_reason: string | null }>(
    (cls || []).map((c: any) => [c.identity_key, c]),
  )

  // Public channels default to Updates by type; everything else to Important
  // (Read Me §5, §8 bootstrap). We don't recompute the full rule set here — the
  // classifier writes the bootstrap row on the first post-migration sync — but
  // this fallback keeps a freshly-seen entity on the right column immediately.
  const fallbackTier = (t: string): Tier => (t === 'public_channel' ? 'updates' : 'important')

  const items = (entities || [])
    .filter((e: any) => e.archived !== true) // Ignore tier — not shown (§4)
    .map((e: any) => {
      const c = clsByKey.get(e.identity_key)
      return {
        identityKey: e.identity_key,
        type: e.slack_entity_type as string,
        name: e.display_name || e.identity_key,
        tier: (c?.tier as Tier) || fallbackTier(e.slack_entity_type),
        confirmed: c?.confirmed ?? true,
        isNew: !(c?.confirmed ?? true),
        reason: c?.bootstrap_reason || null,
        externalShape: e.external_shape as string | null,
      }
    })

  return NextResponse.json({
    updates: items.filter((i: { tier: Tier }) => i.tier === 'updates'),
    important: items.filter((i: { tier: Tier }) => i.tier === 'important'),
  })
}

/**
 * PATCH /api/slack/entities  { identityKey, tier?, confirmed?, confirmAll? }
 * Move / confirm entities on the Slack Kanban (Read Me §8).
 *   - { identityKey, tier }        move an entity to the other column (manual)
 *   - { identityKey, confirmed }   confirm a placement
 *   - { confirmAll: true }         confirm every provisional entity
 * A manual move flips source->manual, confirmed->true. An Updates->Important move
 * additionally dispatches the backfill that re-expands past gist days into full
 * facet notes. Important->Updates needs no backfill — existing notes stand and
 * only new days log as gist (Read Me §8).
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
      .from('slack_classification')
      .update({ confirmed: true, source: 'manual' })
      .eq('user_email', auth.email)
      .eq('card_id', CARD_ID)
      .eq('confirmed', false)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (!body.identityKey) {
    return NextResponse.json({ error: 'identityKey is required' }, { status: 400 })
  }

  const { data: before } = await supa
    .from('slack_classification')
    .select('tier')
    .eq('user_email', auth.email)
    .eq('card_id', CARD_ID)
    .eq('identity_key', body.identityKey)
    .maybeSingle()

  const patch: Record<string, unknown> = {}
  if (body.tier !== undefined) {
    if (!isTier(body.tier)) return NextResponse.json({ error: 'invalid tier' }, { status: 400 })
    patch.tier = body.tier
    patch.confirmed = true
    patch.source = 'manual'
  }
  if (body.confirmed !== undefined) patch.confirmed = body.confirmed
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const { error } = await supa.from('slack_classification').upsert(
    {
      user_email: auth.email,
      card_id: CARD_ID,
      identity_key: body.identityKey,
      ...patch,
    },
    { onConflict: 'user_email,card_id,identity_key' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let backfill: string | null = null
  const movingToImportant = body.tier === 'important'
  const wasUpdates = !before || before.tier === 'updates'
  if (movingToImportant && wasUpdates) {
    const r = await dispatchWorkflow('slack-move-backfill.yml', {
      user_email: auth.email,
      identity_key: body.identityKey,
    })
    if (r.ok) backfill = body.identityKey
  }

  return NextResponse.json({ ok: true, backfill })
}
