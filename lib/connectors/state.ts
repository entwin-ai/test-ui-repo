import { getSupabaseAdmin } from '@/lib/rag/supabase'

/**
 * Per-user connector UI state — the persistence layer behind the Connectors
 * tab. It records, for each connector card and each signed-in user:
 *   • connected  — the Connect/Disconnect toggle
 *   • settings   — the values from that card's settings modal (poll hours,
 *                  backfill days, total window, …), saved on "Save settings".
 *
 * Every function here is scoped by userEmail, which the route handler derives
 * server-side from the NextAuth session and NEVER from client input. Backed by
 * the connector_state table (migration 0010).
 */

/** Stable slug for every connector card in the grid. */
export const CONNECTOR_KEYS = [
  'gmail-personal',
  'gmail-professional',
  'drive-personal',
  'drive-professional',
  'chorale-recorder',
  'calendar',
  'whatsapp',
  'animatics',
  'slack-workspace',
  'browser-history',
] as const

export type ConnectorKey = (typeof CONNECTOR_KEYS)[number]

export function isConnectorKey(v: unknown): v is ConnectorKey {
  return typeof v === 'string' && (CONNECTOR_KEYS as readonly string[]).includes(v)
}

/**
 * The knobs the settings modal exposes. Kept deliberately small and generic so
 * every card shares one shape; unused fields on a given card simply keep their
 * defaults. New per-connector knobs can be added here (and clamped below)
 * without a DB migration — settings is jsonb.
 */
export interface ConnectorSettings {
  pollHours: number
  backfillDays: number
  totalWindowDays: number
}

export const DEFAULT_SETTINGS: ConnectorSettings = {
  pollHours: 24,
  backfillDays: 30,
  totalWindowDays: 365,
}

// Bounds mirror the steppers in ConnectorSettingsModal so a hand-crafted POST
// can never persist an out-of-range value.
const BOUNDS = {
  pollHours: { min: 1, max: 24 },
  backfillDays: { min: 1, max: 100 },
  // The rolling window Entwin keeps indexed going forward. Now user-editable
  // (previously frozen at 365). 30 days to 10 years.
  totalWindowDays: { min: 30, max: 3650 },
} as const

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

/**
 * Coerce arbitrary client input into a safe, fully-populated settings object.
 * Unknown keys are dropped; missing keys fall back to defaults; every numeric
 * field is clamped to its modal bounds.
 */
export function sanitizeSettings(input: unknown): ConnectorSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const backfillDays = clampInt(
    src.backfillDays,
    BOUNDS.backfillDays.min,
    BOUNDS.backfillDays.max,
    DEFAULT_SETTINGS.backfillDays,
  )
  let totalWindowDays = clampInt(
    src.totalWindowDays,
    BOUNDS.totalWindowDays.min,
    BOUNDS.totalWindowDays.max,
    DEFAULT_SETTINGS.totalWindowDays,
  )
  // The rolling window can never be shorter than the one-time backfill — that
  // would mean indexing less history than was initially pulled. Floor it.
  if (totalWindowDays < backfillDays) totalWindowDays = backfillDays
  return {
    pollHours: clampInt(src.pollHours, BOUNDS.pollHours.min, BOUNDS.pollHours.max, DEFAULT_SETTINGS.pollHours),
    backfillDays,
    totalWindowDays,
  }
}

export interface ConnectorStateRecord {
  connectorKey: ConnectorKey
  connected: boolean
  settings: ConnectorSettings
  /** Last time this connector was actually read (on-demand or by the poll),
   *  ISO string, or null if never. Backs the "Last read" line in the modal. */
  lastReadAt: string | null
}

// Postgres/PostgREST signal for a missing column (migration 0019 not applied
// yet). When we see it, we fall back to selecting without last_read_at so an
// un-migrated database never breaks connector reads (which the Gmail scan and
// several other paths depend on). The "Last read" line simply shows "Never"
// until the migration runs.
function isMissingLastReadColumn(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false
  const msg = (err.message || '').toLowerCase()
  return (
    err.code === '42703' || // undefined_column
    (msg.includes('last_read_at') && (msg.includes('does not exist') || msg.includes('column')))
  )
}

const BASE_COLS = 'connector_key, connected, settings'
const COLS_WITH_READ = `${BASE_COLS}, last_read_at`

/** Every stored row for this user, keyed by connectorKey for easy lookup. */
export async function getAllConnectorState(
  userEmail: string,
): Promise<Record<string, ConnectorStateRecord>> {
  const supa = getSupabaseAdmin()
  const first = await supa
    .from('connector_state')
    .select(COLS_WITH_READ)
    .eq('user_email', userEmail)

  let rows: Record<string, unknown>[]
  if (first.error && isMissingLastReadColumn(first.error)) {
    const fallback = await supa.from('connector_state').select(BASE_COLS).eq('user_email', userEmail)
    if (fallback.error) throw new Error(fallback.error.message)
    rows = (fallback.data ?? []) as Record<string, unknown>[]
  } else {
    if (first.error) throw new Error(first.error.message)
    rows = (first.data ?? []) as unknown as Record<string, unknown>[]
  }

  const out: Record<string, ConnectorStateRecord> = {}
  for (const row of rows) {
    const key = row.connector_key as string
    if (!isConnectorKey(key)) continue
    out[key] = {
      connectorKey: key,
      connected: !!row.connected,
      settings: sanitizeSettings(row.settings),
      lastReadAt: (row.last_read_at as string) ?? null,
    }
  }
  return out
}

/** Single card's stored state, or null if the user has never touched it. */
export async function getConnectorState(
  userEmail: string,
  connectorKey: ConnectorKey,
): Promise<ConnectorStateRecord | null> {
  const supa = getSupabaseAdmin()
  const first = await supa
    .from('connector_state')
    .select(COLS_WITH_READ)
    .eq('user_email', userEmail)
    .eq('connector_key', connectorKey)
    .maybeSingle()

  let data: Record<string, unknown> | null
  if (first.error && isMissingLastReadColumn(first.error)) {
    const fallback = await supa
      .from('connector_state')
      .select(BASE_COLS)
      .eq('user_email', userEmail)
      .eq('connector_key', connectorKey)
      .maybeSingle()
    if (fallback.error) throw new Error(fallback.error.message)
    data = (fallback.data as Record<string, unknown> | null) ?? null
  } else {
    if (first.error) throw new Error(first.error.message)
    data = (first.data as unknown as Record<string, unknown> | null) ?? null
  }

  if (!data) return null
  return {
    connectorKey,
    connected: !!data.connected,
    settings: sanitizeSettings(data.settings),
    lastReadAt: (data.last_read_at as string) ?? null,
  }
}

/**
 * Upsert this user's state for one card. Both fields are optional so callers can
 * persist just the toggle (Connect/Disconnect click) or just the settings
 * ("Save settings" click) without clobbering the other. When settings is
 * provided it is fully sanitized first. Returns the merged, persisted record.
 */
export async function upsertConnectorState(
  userEmail: string,
  connectorKey: ConnectorKey,
  patch: { connected?: boolean; settings?: unknown },
): Promise<ConnectorStateRecord> {
  const existing = await getConnectorState(userEmail, connectorKey)

  const connected =
    typeof patch.connected === 'boolean' ? patch.connected : existing?.connected ?? false

  const settings =
    patch.settings !== undefined
      ? sanitizeSettings(patch.settings)
      : existing?.settings ?? DEFAULT_SETTINGS

  const { error } = await getSupabaseAdmin()
    .from('connector_state')
    .upsert(
      {
        user_email: userEmail,
        connector_key: connectorKey,
        connected,
        settings,
      },
      { onConflict: 'user_email,connector_key' },
    )

  if (error) throw new Error(error.message)
  return { connectorKey, connected, settings, lastReadAt: existing?.lastReadAt ?? null }
}

/**
 * Record that this connector was just read (on-demand "Read Now", or the poll).
 * Creates the row if it doesn't exist yet — reading a card the user never saved
 * settings for still gets a timestamp. Returns the ISO timestamp written.
 */
export async function touchLastRead(
  userEmail: string,
  connectorKey: ConnectorKey,
): Promise<string> {
  const now = new Date().toISOString()
  const existing = await getConnectorState(userEmail, connectorKey)
  const supa = getSupabaseAdmin()
  const base = {
    user_email: userEmail,
    connector_key: connectorKey,
    // Preserve current toggle/settings when the row already exists; default
    // for a brand-new row (reading implies the card is in use).
    connected: existing?.connected ?? false,
    settings: existing?.settings ?? DEFAULT_SETTINGS,
  }

  let { error } = await supa
    .from('connector_state')
    .upsert({ ...base, last_read_at: now }, { onConflict: 'user_email,connector_key' })

  // If migration 0019 hasn't been applied, upsert the row WITHOUT the timestamp
  // so the read still succeeds — the "Last read" line just stays "Never".
  if (error && isMissingLastReadColumn(error)) {
    ;({ error } = await supa
      .from('connector_state')
      .upsert(base, { onConflict: 'user_email,connector_key' }))
  }
  if (error) throw new Error(error.message)
  return now
}
