import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/gmail/route-helpers'
import {
  getAllConnectorState,
  upsertConnectorState,
  isConnectorKey,
} from '@/lib/connectors/state'

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
    return NextResponse.json({ ok: true, state: record })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
