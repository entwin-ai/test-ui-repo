import crypto from 'crypto'

/**
 * Per-user profile settings that aren't credentials and aren't per-connector —
 * currently just the Entwin's display name. Stored in the same Upstash Redis as
 * LLM keys and channel sessions, so there's no new store to provision and it
 * survives reloads / device switches (the name was previously local-only React
 * state, lost on refresh).
 *
 * Scoped by the session email, which the route derives server-side and never
 * from client input.
 */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN
const REDIS_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN)

function redisKey(userEmail: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`profile::${userEmail}`.toLowerCase())
    .digest('hex')
    .slice(0, 24)
  return `entwin:profile:${hash}`
}

async function redisCmd(args: (string | number)[]): Promise<unknown> {
  if (!REDIS_ENABLED) {
    throw new Error(
      'Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (same store used for LLM keys).',
    )
  }
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`Redis ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(`Redis error: ${json.error}`)
  return json.result
}

export interface Profile {
  /** The Entwin's display name. Trimmed, capped, never empty once set. */
  entwinName: string
}

const MAX_NAME = 60
const TTL_SECONDS = 365 * 24 * 60 * 60

/** Coerce arbitrary input into a valid name, or null if it isn't usable. */
export function sanitizeName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().slice(0, MAX_NAME)
  return trimmed.length > 0 ? trimmed : null
}

export async function getProfile(userEmail: string): Promise<Profile | null> {
  const raw = (await redisCmd(['GET', redisKey(userEmail)])) as string | null
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Profile>
    const name = sanitizeName(parsed.entwinName)
    if (!name) return null
    return { entwinName: name }
  } catch {
    return null
  }
}

export async function saveProfile(userEmail: string, name: string): Promise<Profile> {
  const clean = sanitizeName(name)
  if (!clean) throw new Error('A name is required.')
  const profile: Profile = { entwinName: clean }
  await redisCmd(['SET', redisKey(userEmail), JSON.stringify(profile), 'EX', TTL_SECONDS])
  return profile
}
