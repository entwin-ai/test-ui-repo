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
  totalWindowDays: { min: 365, max: 365 },
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
  return {
    pollHours: clampInt(src.pollHours, BOUNDS.pollHours.min, BOUNDS.pollHours.max, DEFAULT_SETTINGS.pollHours),
    backfillDays: clampInt(
      src.backfillDays,
      BOUNDS.backfillDays.min,
      BOUNDS.backfillDays.max,
      DEFAULT_SETTINGS.backfillDays,
    ),
    totalWindowDays: clampInt(
      src.totalWindowDays,
      BOUNDS.totalWindowDays.min,
      BOUNDS.totalWindowDays.max,
      DEFAULT_SETTINGS.totalWindowDays,
    ),
  }
}

export interface ConnectorStateRecord {
  connectorKey: ConnectorKey
  connected: boolean
  settings: ConnectorSettings
}

/** Every stored row for this user, keyed by connectorKey for easy lookup. */
export async function getAllConnectorState(
  userEmail: string,
): Promise<Record<string, ConnectorStateRecord>> {
  const { data, error } = await getSupabaseAdmin()
    .from('connector_state')
    .select('connector_key, connected, settings')
    .eq('user_email', userEmail)

  if (error) throw new Error(error.message)

  const out: Record<string, ConnectorStateRecord> = {}
  for (const row of data ?? []) {
    const key = row.connector_key as string
    if (!isConnectorKey(key)) continue
    out[key] = {
      connectorKey: key,
      connected: !!row.connected,
      settings: sanitizeSettings(row.settings),
    }
  }
  return out
}

/** Single card's stored state, or null if the user has never touched it. */
export async function getConnectorState(
  userEmail: string,
  connectorKey: ConnectorKey,
): Promise<ConnectorStateRecord | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('connector_state')
    .select('connector_key, connected, settings')
    .eq('user_email', userEmail)
    .eq('connector_key', connectorKey)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    connectorKey,
    connected: !!data.connected,
    settings: sanitizeSettings(data.settings),
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
  return { connectorKey, connected, settings }
}
