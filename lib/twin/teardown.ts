import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

/**
 * "Kill My Twin" — irreversible, total teardown of everything Entwin holds for
 * ONE user. Called by DELETE /api/twin after the user confirms. Every step is
 * scoped by the session email (passed in by the route from getServerSession,
 * never from request input).
 *
 * What it removes:
 *   1. Supabase — every row in every table keyed by user_email (ingested
 *      email/slack/whatsapp messages, memory notes + chunks, entities +
 *      mentions, rollups, cost log, sync_state, connector_state/settings).
 *   2. Redis (Upstash) — the encrypted LLM API key, and all channel session
 *      credentials/tokens (Gmail x2, Slack, WhatsApp creds/keys/paircode).
 *   3. Scheduled services — deleting the sync_state rows (step 1) is what
 *      actually decommissions the user's scheduled work: the delta/sync GitHub
 *      Actions crons enumerate sync_state, so with no rows the user is never
 *      processed again. Revoking the Redis tokens is the belt-and-braces: even a
 *      run already in flight can no longer authenticate to their accounts.
 *
 * The function is best-effort and continues past individual failures so a single
 * error can't strand the user half-deleted; it returns a per-step report.
 */

// ---- Redis (Upstash REST) --------------------------------------------------

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN
const REDIS_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN)

async function redisDel(keys: string[]): Promise<void> {
  if (!REDIS_ENABLED || keys.length === 0) return
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['DEL', ...keys]),
  })
  if (!res.ok) throw new Error(`Redis DEL failed (${res.status})`)
}

const sha24 = (s: string) => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 24)

/**
 * Every Redis key Entwin can hold for a user. Keys are hashed (not enumerable by
 * pattern), so we reconstruct each one from the email + the known card ids. Keep
 * this in sync with the key schemes in:
 *   lib/rag/llm-keys.ts        entwin:llm:<sha256("llm::"+email)>
 *   lib/gmail/service.ts       entwin:gmail:<sha256(email::card)>
 *   lib/slack/service.ts       entwin:slack:<sha256(email::card)>
 *   lib/whatsapp/service.ts    entwin:wa:{creds,keys,paircode}:<sha256(email)>
 */
function redisKeysForUser(email: string): string[] {
  const gmailCards = ['gmail-personal', 'gmail-professional']
  const slackCards = ['slack-workspace']
  const keys: string[] = [
    `entwin:llm:${sha24(`llm::${email}`)}`,
    ...gmailCards.map((c) => `entwin:gmail:${sha24(`${email}::${c}`)}`),
    ...slackCards.map((c) => `entwin:slack:${sha24(`${email}::${c}`)}`),
    `entwin:wa:creds:${sha24(email)}`,
    `entwin:wa:keys:${sha24(email)}`,
    `entwin:wa:paircode:${sha24(email)}`,
  ]
  return keys
}

// ---- Supabase --------------------------------------------------------------

// Child-before-parent so explicit deletes never race the FK cascades
// (entity_mention/note_chunk -> memory_note -> email_message; entity_mention ->
// entity). Deleting by user_email in this order is safe regardless of cascades.
const USER_TABLES = [
  'entity_mention',
  'note_chunk',
  'memory_note',
  'daily_rollup',
  'email_message',
  'slack_message',
  'whatsapp_message',
  'entity',
  'llm_cost_log',
  'sync_state',
  'connector_state',
] as const

export interface TeardownReport {
  ok: boolean
  supabase: Record<string, { deleted: boolean; error?: string }>
  redis: { deleted: boolean; keyCount: number; error?: string }
  errors: string[]
}

export async function killTwin(userEmail: string): Promise<TeardownReport> {
  const report: TeardownReport = { ok: true, supabase: {}, redis: { deleted: false, keyCount: 0 }, errors: [] }
  const admin = getSupabaseAdmin()

  // 1 + 3. Delete all Supabase rows for the user. Removing sync_state here is
  // also what decommissions the user's scheduled GitHub Actions processing.
  for (const table of USER_TABLES) {
    try {
      const { error } = await admin.from(table).delete().eq('user_email', userEmail)
      if (error) throw new Error(error.message)
      report.supabase[table] = { deleted: true }
    } catch (e) {
      const msg = (e as Error).message
      report.supabase[table] = { deleted: false, error: msg }
      report.errors.push(`supabase.${table}: ${msg}`)
      report.ok = false
    }
  }

  // 2. Revoke every Redis credential (LLM key + all channel sessions/tokens).
  try {
    const keys = redisKeysForUser(userEmail)
    await redisDel(keys)
    report.redis = { deleted: true, keyCount: keys.length }
  } catch (e) {
    const msg = (e as Error).message
    report.redis = { deleted: false, keyCount: 0, error: msg }
    report.errors.push(`redis: ${msg}`)
    report.ok = false
  }

  return report
}
