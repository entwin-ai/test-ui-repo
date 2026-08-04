/**
 * WhatsApp connector service (server-side) — batch/cron model.
 *
 * -----------------------------------------------------------------------------
 * What changed (v4.8 — hourly batch, no live socket in the app)
 * -----------------------------------------------------------------------------
 * The app no longer opens a Baileys socket. WhatsApp is now ingested by a
 * BOUNDED hourly GitHub Actions job (worker MODE=whatsapp-sync) that, per user:
 * loads saved device credentials from Redis, opens a short-lived socket, drains
 * WhatsApp's offline backlog into the whatsapp_message ledger, vectorizes it,
 * and exits. No process holds a socket between runs — so nothing here needs an
 * always-on host.
 *
 * That leaves this service with two small jobs, both stateless:
 *   1. connect(): kick off the ONE-TIME device pairing. Pairing needs a live
 *      socket for the code round-trip, which doesn't belong in a serverless
 *      request — so we DISPATCH the `whatsapp-pair` workflow (or, in local dev,
 *      point the user at `npm run pair`). The actual linking happens in Actions.
 *   2. status(): report ingestion progress by reading Supabase (whatsapp_stats)
 *      and whether the sync_state row exists / is linked.
 *
 * There is intentionally no Baileys import here anymore.
 */

import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/rag/supabase'

export const WA_CARD_ID = 'whatsapp'
export const INITIAL_WINDOW_DAYS = 30
const INITIAL_WINDOW_MS = INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000

export type WaState = 'disconnected' | 'pairing' | 'connected'

/**
 * Whether registered WhatsApp credentials exist for this user in Redis. Mirrors
 * the worker's wa-auth-store key scheme so the app can tell "linked" from
 * "not linked" without opening a socket.
 *   entwin:wa:creds:<sha256(email).slice(0,24)>  -> JSON creds (has .registered)
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

function credsKey(email: string): string {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)
  return `entwin:wa:creds:${hash}`
}

// Mirrors the worker's wa-paircode.js key: the pairing job publishes the code
// here (short TTL) so the connectors tab can show it without opening the log.
function paircodeKey(email: string): string {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)
  return `entwin:wa:paircode:${hash}`
}

async function redisGet(key: string): Promise<string | null> {
  if (!REDIS_ENABLED) return null
  try {
    const res = await fetch(REDIS_URL as string, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: string | null }
    return json.result ?? null
  } catch {
    return null
  }
}

async function isLinked(email: string): Promise<boolean> {
  const raw = await redisGet(credsKey(email))
  if (!raw) return false
  try {
    // creds are stored with Baileys BufferJSON; we only need the registered flag,
    // which is a plain boolean and survives a naive JSON.parse.
    return !!JSON.parse(raw)?.registered
  } catch {
    return false
  }
}

/**
 * The pairing code published by the whatsapp-pair job, if one is currently live
 * (the key has a short TTL and is deleted on successful link). Returned to the
 * UI so the connectors tab can display the code directly.
 */
async function getPairCode(
  email: string,
): Promise<{ code: string; pretty: string; expiresAt: string | null } | null> {
  const raw = await redisGet(paircodeKey(email))
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { code?: string; pretty?: string; expiresAt?: string }
    if (!p?.code) return null
    return { code: p.code, pretty: p.pretty || p.code, expiresAt: p.expiresAt ?? null }
  } catch {
    return null
  }
}

/** Ensure the sync_state row exists so the hourly job enumerates this account. */
async function ensureSyncState(email: string): Promise<void> {
  const floorIso = new Date(Date.now() - INITIAL_WINDOW_MS).toISOString()
  const { error } = await getSupabaseAdmin()
    .from('sync_state')
    .upsert(
      {
        user_email: email,
        card_id: WA_CARD_ID,
        channel: 'whatsapp',
        backfill_done: false,
        wa_backfill_after: floorIso,
      },
      { onConflict: 'user_email,card_id' },
    )
  if (error) throw new Error(`sync_state: ${error.message}`)
}

/**
 * Start WhatsApp pairing for this user's number. Because pairing needs a live
 * socket (for the code round-trip) that can't run in a serverless request, we
 * dispatch the one-time `whatsapp-pair` GitHub Actions workflow with the number.
 * The user then reads the pairing code from the workflow run and enters it on
 * their phone. Returns where to find the code.
 *
 * If GitHub dispatch isn't configured (local dev), we register the sync_state
 * row and return instructions to run `npm run pair` locally instead.
 */
export async function connect(
  email: string,
  phone: string,
): Promise<{ state: WaState; via: 'workflow' | 'local'; runsUrl?: string; message: string }> {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Enter the number in international format including the ISD code, e.g. +1 312 555 1234')
  }

  await ensureSyncState(email)

  const repo = process.env.GH_REPO
  const token = process.env.GH_DISPATCH_TOKEN
  if (!repo || !token) {
    return {
      state: 'pairing',
      via: 'local',
      message:
        `Pairing isn't wired to GitHub Actions here. Run this once to link the device:\n` +
        `  cd worker && USER_EMAIL=${email} WA_PHONE=${digits} npm run pair\n` +
        `then enter the printed code on your phone (WhatsApp → Settings → Linked devices).`,
    }
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/whatsapp-pair.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs: { user_email: email, phone: digits } }),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Could not start pairing workflow: ${res.status} ${detail}`)
  }

  return {
    state: 'pairing',
    via: 'workflow',
    runsUrl: `https://github.com/${repo}/actions/workflows/whatsapp-pair.yml`,
    message:
      'Pairing started. Your pairing code will appear here in a few seconds — enter it on your phone: ' +
      'WhatsApp → Settings → Linked devices → Link with phone number.',
  }
}

/**
 * Disconnect: purge the device credentials from Redis (revokes the local link)
 * and mark the account for re-pair. We keep already-ingested memory in place.
 */
export async function disconnect(email: string): Promise<void> {
  if (REDIS_ENABLED) {
    const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)
    try {
      await fetch(REDIS_URL as string, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['DEL', `entwin:wa:creds:${hash}`, `entwin:wa:keys:${hash}`]),
      })
    } catch {
      /* best-effort */
    }
  }
  // Flip the row back to unlinked so the UI reflects it and a future connect re-pairs.
  try {
    await getSupabaseAdmin()
      .from('sync_state')
      .update({ backfill_done: false, updated_at: new Date().toISOString() })
      .eq('user_email', email)
      .eq('card_id', WA_CARD_ID)
  } catch {
    /* best-effort */
  }
}

/**
 * Live status for the UI: linked/pairing state (from Redis creds) plus durable
 * ingestion counts (from Supabase). No socket involved.
 */
export async function status(email: string) {
  const linked = await isLinked(email)
  // Only surface a live pairing code when NOT yet linked (mid-pairing).
  const pair = linked ? null : await getPairCode(email)

  let totalMessages = 0
  let processedMessages = 0
  let chats = 0
  let earliest: string | null = null
  let latest: string | null = null
  let hasRow = false
  try {
    const supa = getSupabaseAdmin()
    const [{ data: stats }, { data: rows }] = await Promise.all([
      supa.rpc('whatsapp_stats', { p_user_email: email }),
      supa.from('sync_state').select('id').eq('user_email', email).eq('card_id', WA_CARD_ID).limit(1),
    ])
    const row = Array.isArray(stats) ? stats[0] : stats
    if (row) {
      totalMessages = Number(row.total_messages) || 0
      processedMessages = Number(row.processed_messages) || 0
      chats = Number(row.chats) || 0
      earliest = row.earliest ?? null
      latest = row.latest ?? null
    }
    hasRow = Array.isArray(rows) && rows.length > 0
  } catch {
    /* DB unavailable — return what we have */
  }

  // "connected" once the device is linked; "pairing" if a row exists but no
  // creds yet (pairing in flight); otherwise disconnected.
  const state: WaState = linked ? 'connected' : hasRow ? 'pairing' : 'disconnected'

  return {
    state,
    linked,
    // Live pairing code (null unless a pairing job is mid-flight). The UI shows
    // this in the WhatsApp box so the user never opens the Actions log.
    pairingCode: pair?.pretty ?? null,
    pairingCodeExpiresAt: pair?.expiresAt ?? null,
    totalMessages,
    processedMessages,
    chats,
    earliest,
    latest,
  }
}
