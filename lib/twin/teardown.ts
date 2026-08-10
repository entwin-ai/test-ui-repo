import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

/**
 * "Kill My Twin" — irreversible, total teardown of everything Entwin holds for
 * ONE user. Called by DELETE /api/twin after the user confirms. Every step is
 * scoped by the session email (passed in by the route from getServerSession,
 * never from request input).
 *
 * What it removes:
 *   1. Supabase — every row in every table keyed by user_email: chat history
 *      (chat_session/chat_message), ingested email/slack/whatsapp messages,
 *      memory notes + chunks, entities + mentions + note_ownership, daily
 *      rollups, sender_classification, the whatsapp metadata/classification
 *      tables (entity/classification/capability_probe), the Google Drive
 *      per-file diff ledger (drive_file), cost log, sync_state and
 *      connector_state. USER_TABLES below must stay in sync with the schema:
 *      every table carrying a user_email column has to be listed there.
 *   2. Redis (Upstash) — the encrypted LLM API key, the cached profile, all
 *      channel session credentials/tokens (Gmail x2, Slack, Drive x2, WhatsApp
 *      creds/keys/paircode), and the Animatics pipeline state (job blob, every
 *      character headshot, and the owner index).
 *   3. Scheduled services — deleting the sync_state rows (step 1) is what
 *      actually decommissions the user's scheduled work: the delta/sync GitHub
 *      Actions crons enumerate sync_state, so with no rows the user is never
 *      processed again. Revoking the Redis tokens is the belt-and-braces: even a
 *      run already in flight can no longer authenticate to their accounts.
 *   4. In-flight runs — any GitHub Actions run already executing for this user
 *      at the moment of deletion is cancelled directly (attributed via the
 *      per-user run-name marker on the dispatch workflows). This closes the gap
 *      the earlier version left open. It requires GH_REPO + GH_DISPATCH_TOKEN;
 *      when those aren't set the step is skipped (token revocation still applies).
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

async function redisGet(key: string): Promise<string | null> {
  if (!REDIS_ENABLED) return null
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', key]),
  })
  if (!res.ok) throw new Error(`Redis GET failed (${res.status})`)
  const json = (await res.json()) as { result?: unknown }
  return (json.result as string | null) ?? null
}

const sha24 = (s: string) => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 24)

/**
 * Every Redis key Entwin can hold for a user. Keys are hashed (not enumerable by
 * pattern), so we reconstruct each one from the email + the known card ids. Keep
 * this in sync with the key schemes in:
 *   lib/rag/llm-keys.ts        entwin:llm:<sha256("llm::"+email)>
 *   lib/twin/profile.ts        entwin:profile:<sha256("profile::"+email)>
 *   lib/gmail/service.ts       entwin:gmail:<sha256(email::card)>
 *   lib/slack/service.ts       entwin:slack:<sha256(email::card)>
 *   lib/drive/service.ts       entwin:drive:<sha256(email::card)>
 *   lib/whatsapp/service.ts    entwin:wa:{creds,keys,paircode}:<sha256(email)>
 */
function redisKeysForUser(email: string): string[] {
  const gmailCards = ['gmail-personal', 'gmail-professional']
  const slackCards = ['slack-workspace']
  const driveCards = ['drive-personal', 'drive-professional']
  const keys: string[] = [
    `entwin:llm:${sha24(`llm::${email}`)}`,
    `entwin:profile:${sha24(`profile::${email}`)}`,
    ...gmailCards.map((c) => `entwin:gmail:${sha24(`${email}::${c}`)}`),
    ...slackCards.map((c) => `entwin:slack:${sha24(`${email}::${c}`)}`),
    ...driveCards.map((c) => `entwin:drive:${sha24(`${email}::${c}`)}`),
    `entwin:wa:creds:${sha24(email)}`,
    `entwin:wa:keys:${sha24(email)}`,
    `entwin:wa:paircode:${sha24(email)}`,
  ]
  return keys
}

/**
 * Animatics Redis keys are NOT reconstructable from the email alone: the job and
 * headshot keys are keyed by a random job id (entwin:animatics:job:<uuid>,
 * entwin:animatics:headshot:<uuid>:<charId>). The only stable, email-derived
 * anchor is the owner index (entwin:animatics:owner:<sha256(email).slice(0,24)>,
 * see lib/animatics/store.ts), which points at the user's latest job id. So we
 * resolve the job dynamically: read the owner index → load the job blob →
 * enumerate its per-character headshot keys → return job blob + headshots +
 * owner index for deletion. Best-effort: any read failure just yields fewer
 * keys, never throws into the teardown.
 */
async function animaticsKeysForUser(email: string): Promise<string[]> {
  if (!REDIS_ENABLED) return []
  const ownerKey = `entwin:animatics:owner:${sha24(email)}`
  const keys: string[] = [ownerKey]
  try {
    const jobId = await redisGet(ownerKey)
    if (jobId) {
      const jobKey = `entwin:animatics:job:${jobId}`
      keys.push(jobKey)
      // Load the job blob to enumerate its character headshot keys.
      const raw = await redisGet(jobKey)
      if (raw) {
        try {
          const job = JSON.parse(raw) as { characters?: { id: string }[] }
          for (const c of job.characters || []) {
            if (c?.id) keys.push(`entwin:animatics:headshot:${jobId}:${c.id}`)
          }
        } catch {
          /* malformed blob — still delete the job + owner keys we already have */
        }
      }
    }
  } catch {
    /* owner/job read failed — fall back to deleting just the owner index */
  }
  return keys
}

// ---- GitHub Actions (in-flight run cancellation) ---------------------------

const GH_REPO = process.env.GH_REPO
const GH_TOKEN = process.env.GH_DISPATCH_TOKEN
const GH_ENABLED = Boolean(GH_REPO && GH_TOKEN)

// Every user-scoped dispatch workflow embeds the target email in its run-name as
// `entwin-user:<email>` (see .github/workflows/*.yml). That marker is what makes
// a run attributable to one user — the dispatch INPUTS aren't queryable from the
// runs list, but the run's display_title (set from run-name) is. We match on it
// to cancel only THIS user's in-flight work, never anyone else's.
function userRunMarker(email: string): string {
  return `entwin-user:${email.toLowerCase()}`
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers || {}),
    },
  })
}

interface CancelResult {
  attempted: boolean
  cancelled: number
  matched: number
  error?: string
}

/**
 * Cancel every in-progress or queued GitHub Actions run attributable to this
 * user (via the run-name marker). This complements the sync_state deletion:
 * that stops the user from being PICKED UP again, this stops a run already
 * executing at the moment of deletion. Best-effort — a failure here never
 * strands the teardown, and token revocation (Redis step) already neutralizes
 * any run that keeps executing regardless.
 */
async function cancelInFlightRuns(userEmail: string): Promise<CancelResult> {
  if (!GH_ENABLED) return { attempted: false, cancelled: 0, matched: 0 }
  const marker = userRunMarker(userEmail)
  let cancelled = 0
  let matched = 0
  try {
    // Only these two statuses can be cancelled; query each and page a little.
    for (const status of ['in_progress', 'queued'] as const) {
      let page = 1
      // A handful of pages is plenty; a single user won't have hundreds of
      // concurrent runs, and we never want an unbounded loop in teardown.
      for (; page <= 5; page++) {
        const res = await ghFetch(
          `/repos/${GH_REPO}/actions/runs?status=${status}&per_page=100&page=${page}`,
        )
        if (!res.ok) throw new Error(`list runs (${status}) ${res.status}`)
        const data = (await res.json()) as {
          workflow_runs?: { id: number; display_title?: string; name?: string }[]
        }
        const runs = data.workflow_runs || []
        if (runs.length === 0) break
        for (const run of runs) {
          const hay = `${run.display_title || ''} ${run.name || ''}`.toLowerCase()
          if (!hay.includes(marker)) continue
          matched++
          const cancel = await ghFetch(`/repos/${GH_REPO}/actions/runs/${run.id}/cancel`, {
            method: 'POST',
          })
          // 202 accepted; 409 = already completing/cannot cancel — both fine.
          if (cancel.ok || cancel.status === 409) cancelled++
        }
        if (runs.length < 100) break
      }
    }
    return { attempted: true, cancelled, matched }
  } catch (e) {
    return { attempted: true, cancelled, matched, error: (e as Error).message }
  }
}


// Ordered children-before-parents so a delete-by-user_email is safe regardless
// of whether a given FK has ON DELETE CASCADE. Known FK edges (all cascade
// unless noted): chat_message -> chat_session; note_ownership -> memory_note,
// entity; entity_mention -> memory_note, email/slack/whatsapp_message, entity;
// note_chunk -> memory_note. Leaf/reference tables (rollups, cost log,
// sync_state, connector_state, sender_classification, whatsapp_* metadata) have
// no inbound user-data FKs and can go anywhere. This list must cover EVERY table
// with a user_email column — the schema currently has 19 such tables (see
// supabase/migrations); missing one strands that user's data on teardown.
const USER_TABLES = [
  // chat history (0020): message references session (cascade) -> delete first
  'chat_message',
  'chat_session',
  // note/entity graph: ownership + mentions + chunks reference notes/entities
  'note_ownership',
  'entity_mention',
  'note_chunk',
  'memory_note',
  'daily_rollup',
  // ingested source messages (referenced by entity_mention, already gone above)
  'email_message',
  'slack_message',
  'whatsapp_message',
  'entity',
  // per-user classification + connector/sync/cost state (no inbound FKs)
  'sender_classification',
  'whatsapp_entity',
  'whatsapp_classification',
  'whatsapp_capability_probe',
  'drive_file',
  'llm_cost_log',
  'sync_state',
  'connector_state',
] as const

export interface TeardownReport {
  ok: boolean
  supabase: Record<string, { deleted: boolean; error?: string }>
  redis: { deleted: boolean; keyCount: number; error?: string }
  githubRuns: { attempted: boolean; cancelled: number; matched: number; error?: string }
  errors: string[]
}

export async function killTwin(userEmail: string): Promise<TeardownReport> {
  const report: TeardownReport = {
    ok: true,
    supabase: {},
    redis: { deleted: false, keyCount: 0 },
    githubRuns: { attempted: false, cancelled: 0, matched: 0 },
    errors: [],
  }
  const admin = getSupabaseAdmin()

  // 4. Cancel any in-flight GitHub Actions run attributable to this user, BEFORE
  // we delete the sync_state rows that would otherwise let it keep working. This
  // is the piece the earlier teardown left as a known gap: sync_state deletion
  // stops the user being picked up again; this stops a run already executing.
  // Best-effort — never fails the teardown; token revocation (step 2) is the
  // backstop even if a run somehow survives.
  report.githubRuns = await cancelInFlightRuns(userEmail)
  if (report.githubRuns.error) {
    report.errors.push(`github: ${report.githubRuns.error}`)
    // Not fatal to overall teardown; leave report.ok as-is unless data steps fail.
  }

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

  // 2. Revoke every Redis credential (LLM key + all channel sessions/tokens)
  // and delete every user-scoped Redis blob (LLM/profile/Gmail/Slack/Drive/
  // WhatsApp credentials + the Animatics job, headshots, and owner index).
  try {
    const staticKeys = redisKeysForUser(userEmail)
    const animaticsKeys = await animaticsKeysForUser(userEmail)
    const keys = [...staticKeys, ...animaticsKeys]
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
