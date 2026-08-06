/**
 * Gmail connector service (server-side).
 *
 * What it does
 * ------------
 * Entwin reads a user's Gmail so the vault always knows their pending
 * activities, upcoming appointments, and who they still owe a reply. To do
 * that it needs the read-only Gmail scope, which is *incremental*: the base
 * NextAuth login only asks for `openid email profile`, and we request the
 * heavier `gmail.readonly` scope separately, at the moment the user clicks
 * "Connect" on a Gmail card. That keeps the initial sign-in lightweight and
 * only asks for mailbox access when the user actually opts in.
 *
 * The consent flow (per Gmail card):
 *   1. UI hits /api/gmail/authorize -> we build a Google consent URL with
 *      prompt=select_account+consent so the account chooser appears, and
 *      redirect the browser to accounts.google.com.
 *   2. Google redirects back to /api/gmail/callback with a code.
 *   3. We exchange the code for tokens and store them per (user, cardId).
 *   4. UI hits /api/gmail/scan, which counts the last 12 months of INBOX and
 *      SENT and returns the two counts.
 *
 * We deliberately do NOT save email bodies here — per the current spec we
 * only *count* the last year (inbox + sent). The token is what persists;
 * no message content is fetched or stored.
 *
 * -----------------------------------------------------------------------------
 * Why this file was rewritten (v3.1)
 * -----------------------------------------------------------------------------
 * Two production bugs made "email reading" appear broken on Vercel:
 *
 *   (A) TIMEOUT. The old scan fetched the Message-Id header for *every*
 *       message (one HTTP round-trip each) purely to dedup a count. A year of
 *       mail is easily 10k-20k messages => 10k-20k serverless-bound fetches,
 *       which never completes inside a Vercel function's wall-clock limit.
 *       Since we only need COUNTS, we now page messages.list (500 ids/page,
 *       ~30 calls for a large mailbox) and count ids. No per-message fetch.
 *       messages.list is already thread-scoped per label, so the practical
 *       count is what the user sees in Gmail's own INBOX / SENT views.
 *
 *   (B) LOST TOKENS. The old store was a plain module-level `Map`. On Vercel,
 *       /api/gmail/callback and /api/gmail/scan can execute in *different*
 *       lambda instances, so the token written during the callback was gone
 *       by the time scan ran -> "Gmail is not connected for this card". We now
 *       mirror the WhatsApp connector: a globalThis-pinned in-memory cache
 *       backed by a small JSON file per (user, card) under a resolved data
 *       root, so tokens survive across invocations on the same instance and
 *       across warm reloads.
 *
 * Storage note: on Vercel the only writable path is /tmp, which is per-instance
 * and may be wiped between cold starts — so file persistence there is
 * best-effort, exactly as it is for the WhatsApp connector. For durable,
 * cross-instance tokens, point ENTWIN_DATA_DIR at a mounted volume or swap the
 * read/writeStore helpers below for a KV/Redis/DB implementation. The public
 * function signatures (buildAuthUrl, handleCallback, scan, status, disconnect)
 * are unchanged, so nothing outside this file needs to change.
 */

import crypto from 'crypto'
import { getConnectorState, DEFAULT_SETTINGS, isConnectorKey } from '@/lib/connectors/state'

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** A backfill window of `days` days, expressed the way Gmail search wants it. */
function windowQuery(days: number): string {
  // The scan window must match the user's "Initial ingestion (one-time
  // backfill)" setting (connector_state.settings.backfillDays) so the count the
  // UI shows equals what the backfill will actually ingest. Formatted as
  // Gmail's after:YYYY/MM/DD (raw epoch in after: is unreliable and silently
  // drops results).
  const d = new Date()
  d.setDate(d.getDate() - Math.max(1, Math.trunc(days)))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `after:${y}/${m}/${day}`
}

export type GmailState = 'disconnected' | 'authorizing' | 'connected'

export interface GmailScanResult {
  inboxCount: number
  sentCount: number
  capped?: boolean // true when MAX_PAGES was hit — counts are a lower bound
  scannedAt: number
}

interface GmailSession {
  state: GmailState
  connectedEmail?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // unix ms
  scan?: GmailScanResult
}

/* ---------------------------------------------------------------------------
 * Persistence
 *
 * A globalThis-pinned in-memory cache (so a warm lambda / dev hot-reload reuses
 * it) backed by a shared Upstash Redis store (see the store section below). The
 * shared store is what makes tokens survive a callback and scan landing on
 * different serverless instances — the old per-instance JSON-file store did
 * not, which is why scans failed with "Gmail is not connected for this card".
 * ------------------------------------------------------------------------- */

const g = globalThis as unknown as {
  __entwinGmailSessions?: Map<string, GmailSession>
}
if (!g.__entwinGmailSessions) g.__entwinGmailSessions = new Map<string, GmailSession>()

/** In-memory cache of sessions, keyed `${userEmail}::${cardId}`. */
const sessions: Map<string, GmailSession> = g.__entwinGmailSessions

/* ---------------------------------------------------------------------------
 * OAuth `state` — stateless & signed.
 *
 * The `state` param we hand Google must round-trip through the browser and come
 * back to /api/gmail/callback. We must NOT keep it in a server-side Map: on
 * Vercel the callback frequently lands on a *different* lambda instance than the
 * one that built the authorize URL, so an in-memory pending map is empty on
 * return and every connect fails with "Unknown or expired OAuth state" — which
 * is exactly the silent "returns home, still Not connected" bug.
 *
 * Instead we encode {userEmail, cardId, ts} into the state itself and sign it
 * with an HMAC keyed on NEXTAUTH_SECRET. Any instance can verify it with no
 * shared memory. The signature stops a user from forging a state for another
 * account; the timestamp bounds replay.
 * ------------------------------------------------------------------------- */

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes to complete the consent screen

function stateSecret(): string {
  const s = process.env.NEXTAUTH_SECRET
  if (!s) throw new Error('NEXTAUTH_SECRET is not set (required to sign OAuth state)')
  return s
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Build a signed, self-contained state token: `<payload>.<sig>`. */
function encodeState(userEmail: string, cardId: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({ userEmail, cardId, ts: Date.now() })))
  const sig = b64url(crypto.createHmac('sha256', stateSecret()).update(payload).digest())
  return `${payload}.${sig}`
}

/** Verify a state token and return its claims, or throw if invalid/expired. */
function decodeState(state: string): { userEmail: string; cardId: string } {
  const [payload, sig] = state.split('.')
  if (!payload || !sig) throw new Error('Malformed OAuth state')

  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest()
  const got = b64urlDecode(sig)
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw new Error('OAuth state signature mismatch')
  }

  const claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as {
    userEmail: string
    cardId: string
    ts: number
  }
  if (!claims.ts || Date.now() - claims.ts > STATE_TTL_MS) {
    throw new Error('OAuth state expired — please try connecting again')
  }
  return { userEmail: claims.userEmail, cardId: claims.cardId }
}

/* ---------------------------------------------------------------------------
 * Durable store — Upstash Redis over its REST API.
 *
 * The previous file-based store lost tokens on Vercel: /api/gmail/callback and
 * /api/gmail/scan run on different lambda instances, and the /tmp fallback is
 * per-instance, so the scan never saw the token the callback wrote. A shared
 * external store fixes that. We use Upstash's REST endpoint (plain fetch, no
 * SDK) so there's no extra dependency and it works on any Vercel plan.
 *
 * Set these env vars (Vercel → Storage → Upstash gives you both):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * If they're absent (e.g. local dev), we fall back to the in-memory Map only —
 * fine for a single `next dev` process, and the store calls become no-ops.
 * ------------------------------------------------------------------------- */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL ||
  process.env.STORAGE_REST_URL
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  process.env.STORAGE_REST_TOKEN
const REDIS_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN)

// Tokens expire; there's no reason to keep a session forever. 30 days covers a
// long-lived refresh token while letting abandoned sessions age out.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

function keyFor(userEmail: string, cardId: string): string {
  return `${userEmail}::${cardId}`
}

/** Opaque, collision-resistant Redis key for a (user, card) pair. */
function redisKey(userEmail: string, cardId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(keyFor(userEmail, cardId).toLowerCase())
    .digest('hex')
    .slice(0, 24)
  return `entwin:gmail:${hash}`
}

/** Fire a single Upstash REST command: POST [cmd, ...args] as a JSON array. */
async function redisCmd(args: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Redis command failed: ${res.status} ${detail}`)
  }
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(`Redis error: ${json.error}`)
  return json.result
}

/** Persist a session (best-effort; never throws into the request path). */
async function writeStore(userEmail: string, cardId: string, sess: GmailSession): Promise<void> {
  if (!REDIS_ENABLED) return
  try {
    await redisCmd(['SET', redisKey(userEmail, cardId), JSON.stringify(sess), 'EX', SESSION_TTL_SECONDS])
  } catch {
    /* store unavailable — in-memory cache still serves warm hits this instance */
  }
}

/** Load a session from the store if present. */
async function readStore(userEmail: string, cardId: string): Promise<GmailSession | undefined> {
  if (!REDIS_ENABLED) return undefined
  try {
    const raw = (await redisCmd(['GET', redisKey(userEmail, cardId)])) as string | null
    if (!raw) return undefined
    return JSON.parse(raw) as GmailSession
  } catch {
    return undefined
  }
}

async function deleteStore(userEmail: string, cardId: string): Promise<void> {
  if (!REDIS_ENABLED) return
  try {
    await redisCmd(['DEL', redisKey(userEmail, cardId)])
  } catch {
    /* ignore */
  }
}

/**
 * Get a session: in-memory cache first (warm hits on the same instance), then
 * the shared store, then a fresh disconnected one. The store read is what makes
 * tokens survive a callback and scan landing on different lambda instances.
 */
async function getSession(userEmail: string, cardId: string): Promise<GmailSession> {
  const k = keyFor(userEmail, cardId)
  const cached = sessions.get(k)
  if (cached) return cached

  const fromStore = await readStore(userEmail, cardId)
  if (fromStore) {
    sessions.set(k, fromStore)
    return fromStore
  }

  const fresh: GmailSession = { state: 'disconnected' }
  sessions.set(k, fresh)
  return fresh
}

/** Write a session through both the in-memory cache and the shared store. */
async function saveSession(userEmail: string, cardId: string, sess: GmailSession): Promise<void> {
  sessions.set(keyFor(userEmail, cardId), sess)
  await writeStore(userEmail, cardId, sess)
}

/* ---------------------------------------------------------------------------
 * OAuth
 * ------------------------------------------------------------------------- */

function redirectUri(): string {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/api/gmail/callback`
}

/** Build the Google consent URL and register the pending flow. */
export async function buildAuthUrl(userEmail: string, cardId: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set')

  // Stateless signed state — no server-side pending map (see notes above).
  const state = encodeState(userEmail, cardId)

  const sess = await getSession(userEmail, cardId)
  sess.state = 'authorizing'
  await saveSession(userEmail, cardId, sess)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    // Ask for Gmail read on top of the identity we already have.
    scope: `openid email ${GMAIL_SCOPE}`,
    // select_account => the Google account chooser; consent => always show
    // the permissions screen so the user explicitly grants mailbox reading.
    prompt: 'select_account consent',
    access_type: 'offline', // get a refresh token so scans can run later
    include_granted_scopes: 'true',
    state,
  })
  return `${OAUTH_AUTH_URL}?${params.toString()}`
}

/** Exchange the OAuth code for tokens and attach them to the card session. */
export async function handleCallback(
  code: string,
  state: string,
): Promise<{ userEmail: string; cardId: string }> {
  // Verify the signed state — any instance can do this with no shared memory.
  const flow = decodeState(state)

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth env vars are not set')

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  })

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Token exchange failed: ${res.status} ${detail}`)
  }
  const tok = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    id_token?: string
  }

  // Which Google account did they actually pick? Ask the userinfo endpoint.
  let connectedEmail: string | undefined
  try {
    const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })
    if (ui.ok) connectedEmail = ((await ui.json()) as { email?: string }).email
  } catch {
    /* non-fatal */
  }

  const sess = await getSession(flow.userEmail, flow.cardId)
  sess.state = 'connected'
  sess.accessToken = tok.access_token
  if (tok.refresh_token) sess.refreshToken = tok.refresh_token
  sess.expiresAt = Date.now() + tok.expires_in * 1000
  sess.connectedEmail = connectedEmail
  await saveSession(flow.userEmail, flow.cardId, sess)

  return { userEmail: flow.userEmail, cardId: flow.cardId }
}

/**
 * Make sure we have a non-expired access token, refreshing if needed. The
 * refreshed token is persisted so subsequent invocations (possibly on other
 * instances) reuse it instead of forcing a reconnect.
 */
async function ensureAccessToken(
  userEmail: string,
  cardId: string,
  sess: GmailSession,
): Promise<string> {
  if (sess.accessToken && sess.expiresAt && Date.now() < sess.expiresAt - 60_000) {
    return sess.accessToken
  }
  if (!sess.refreshToken) {
    if (sess.accessToken) return sess.accessToken // best effort
    throw new Error('No valid Gmail token; reconnect required')
  }
  const clientId = process.env.GOOGLE_CLIENT_ID as string
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET as string
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: sess.refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error('Failed to refresh Gmail token')
  const tok = (await res.json()) as { access_token: string; expires_in: number }
  sess.accessToken = tok.access_token
  sess.expiresAt = Date.now() + tok.expires_in * 1000
  await saveSession(userEmail, cardId, sess)
  return sess.accessToken
}

/* ---------------------------------------------------------------------------
 * Counting
 * ------------------------------------------------------------------------- */

/**
 * Count messages in one Gmail label over the last year.
 *
 * We page through messages.list (up to 500 ids per page) and sum the number of
 * ids. No per-message fetch. To guarantee the scan finishes inside the
 * serverless time budget regardless of mailbox size, we cap the number of pages
 * (MAX_PAGES). If the cap is hit, the returned count is a lower bound and
 * `capped` is true, so the caller can label the number as "at least N".
 */
const MAX_PAGES = 120 // 120 * 500 = up to 60,000 messages per label before capping

async function countLabel(
  accessToken: string,
  labelId: 'INBOX' | 'SENT',
  days: number,
): Promise<{ count: number; capped: boolean }> {
  const q = windowQuery(days)
  let pageToken: string | undefined
  let total = 0
  let pages = 0

  do {
    const listUrl = new URL(`${GMAIL_API}/messages`)
    listUrl.searchParams.set('labelIds', labelId)
    if (q) listUrl.searchParams.set('q', q)
    listUrl.searchParams.set('maxResults', '500')
    // Only ids are needed for a count; this keeps the payload minimal.
    listUrl.searchParams.set('fields', 'messages/id,nextPageToken')
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

    const listRes = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!listRes.ok) {
      const detail = await listRes.text().catch(() => '')
      throw new Error(`Gmail list failed (${labelId}): ${listRes.status} ${detail}`)
    }
    // HTTP 204 No Content = the label genuinely has no messages in this window
    // (e.g. an account that has never sent mail). Not an error — count 0, done.
    if (listRes.status === 204) {
      return { count: total, capped: false }
    }
    // Read as text first: a 200 with an empty/truncated body (proxy hiccup,
    // partial response) would make res.json() throw the opaque
    // "Unexpected end of JSON input". Naming the label makes the cause visible.
    const bodyText = await listRes.text()
    if (!bodyText) {
      // 200-family with a blank body — treat as no results for this page rather
      // than failing the whole scan.
      return { count: total, capped: false }
    }
    let page: { messages?: { id: string }[]; nextPageToken?: string }
    try {
      page = JSON.parse(bodyText)
    } catch {
      throw new Error(
        `Gmail list returned non-JSON (${labelId}): ${bodyText.slice(0, 200)}`,
      )
    }
    total += (page.messages ?? []).length
    pageToken = page.nextPageToken
    pages += 1
    if (pages >= MAX_PAGES && pageToken) {
      return { count: total, capped: true }
    }
  } while (pageToken)

  return { count: total, capped: false }
}

/** Count the last year of inbox + sent and cache the result. */
export async function scan(userEmail: string, cardId: string): Promise<GmailScanResult> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected') throw new Error('Gmail is not connected for this card')
  const accessToken = await ensureAccessToken(userEmail, cardId, sess)

  // Window comes from THIS user's "Initial ingestion (one-time backfill)"
  // setting for THIS card, so the count shown equals what will be ingested.
  // Falls back to the default if the user never saved settings.
  const state = isConnectorKey(cardId) ? await getConnectorState(userEmail, cardId) : null
  const days = state?.settings.backfillDays ?? DEFAULT_SETTINGS.backfillDays

  // Run both labels in parallel — they're independent, so worst-case wall time
  // is one label's worth of paging, not two.
  const [inbox, sent] = await Promise.all([
    countLabel(accessToken, 'INBOX', days),
    countLabel(accessToken, 'SENT', days),
  ])

  const result: GmailScanResult = {
    inboxCount: inbox.count,
    sentCount: sent.count,
    capped: inbox.capped || sent.capped,
    scannedAt: Date.now(),
  }
  sess.scan = result
  await saveSession(userEmail, cardId, sess)
  return result
}

/* ---------------------------------------------------------------------------
 * Status / disconnect
 * ------------------------------------------------------------------------- */

export interface GmailStatus {
  state: GmailState
  connectedEmail: string | null
  scan: GmailScanResult | null
}

export async function status(userEmail: string, cardId: string): Promise<GmailStatus> {
  const sess = await getSession(userEmail, cardId)
  return {
    state: sess.state,
    connectedEmail: sess.connectedEmail ?? null,
    scan: sess.scan ?? null,
  }
}

export async function disconnect(userEmail: string, cardId: string): Promise<void> {
  sessions.delete(keyFor(userEmail, cardId))
  await deleteStore(userEmail, cardId)
}
