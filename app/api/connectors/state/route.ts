import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import {
  getAllConnectorState,
  upsertConnectorState,
  isConnectorKey,
} from '@/lib/connectors/state'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/connectors/state
 * Returns this user's saved state for every connector card:
 *   { states: { "<connectorKey>": { connected, settings }, … } }
 * The Connectors tab reads this on mount to restore toggles + settings.
 */
export async function GET() {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  try {
    const states = await getAllConnectorState(auth.email)
    return NextResponse.json({ states })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * PATCH /api/connectors/state
 *   { connectorKey, connected?, settings? }
 *
 * Upserts one card's state for the signed-in user. `connected` alone persists a
 * Connect/Disconnect click; `settings` alone persists a "Save settings" click;
 * either can be sent without disturbing the other. Settings are sanitized and
 * clamped server-side.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireUser()
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({}))
  const { connectorKey, connected, settings } = body ?? {}

  if (!isConnectorKey(connectorKey)) {
    return NextResponse.json({ error: 'Invalid or missing connectorKey' }, { status: 400 })
  }
  if (connected !== undefined && typeof connected !== 'boolean') {
    return NextResponse.json({ error: '`connected` must be a boolean' }, { status: 400 })
  }
  if (connected === undefined && settings === undefined) {
    return NextResponse.json(
      { error: 'Nothing to update — provide `connected` and/or `settings`' },
      { status: 400 },
    )
  }

  try {
    const record = await upsertConnectorState(auth.email, connectorKey, { connected, settings })

    // WhatsApp: if the user changes "Initial ingestion (one-time backfill)"
    // BEFORE the first backfill has run, push the new window straight onto
    // sync_state.wa_backfill_after so the pending backfill honors it (save 10 ->
    // pulls last 10 days). We never move the floor once backfill_done is true —
    // that history is already ingested; widening it later is the heavier
    // re-backfill path, not a settings toggle.
    let windowApplied: number | null = null
    if (connectorKey === 'whatsapp' && settings !== undefined) {
      const days = Math.max(1, Math.trunc(record.settings.backfillDays))
      const supa = getSupabaseAdmin()
      const { data: ss } = await supa
        .from('sync_state')
        .select('id, backfill_done')
        .eq('user_email', auth.email)
        .eq('card_id', 'whatsapp')
        .maybeSingle()
      if (ss && ss.backfill_done !== true) {
        const floorIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        await supa
          .from('sync_state')
          .update({ wa_backfill_after: floorIso, updated_at: new Date().toISOString() })
          .eq('id', ss.id)
        windowApplied = days
      }
    }

    return NextResponse.json({ ok: true, state: record, whatsappWindowDays: windowApplied })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
