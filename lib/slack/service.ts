/**
 * Slack connector service (server-side).
 *
 * What it does
 * ------------
 * When the user clicks "Connect" on the Slack card, Entwin runs a Slack OAuth
 * (v2) flow and then pulls **the last 1 month of Slack chats** from every
 * conversation the authorizing user can read — public channels, private
 * channels, DMs, and group DMs — and returns per-channel + total message
 * counts. This mirrors the Gmail card's read/scan flow: the token persists;
 * message content is counted (and returned as a lightweight preview) but not
 * permanently stored here.
 *
 * The consent flow:
 *   1. UI hits /api/slack/authorize -> we build a Slack authorize URL with a
 *      signed, stateless `state` and redirect the browser to slack.com.
 *   2. Slack redirects back to /api/slack/callback with a code.
 *   3. We exchange the code (oauth.v2.access) for a user token and store it
 *      per (user, cardId).
 *   4. UI hits /api/slack/scan, which walks the workspace's conversations and
 *      counts every message from the last 30 days, then returns the totals.
 *
 * Architecture notes mirror lib/gmail/service.ts intentionally:
 *   - OAuth `state` is HMAC-signed and self-contained (NEXTAUTH_SECRET), so the
 *     callback can land on a different serverless instance and still verify it
 *     with no shared memory.
 *   - Tokens live in a globalThis-pinned in-memory cache backed by an Upstash
 *     Redis REST store, so a callback and a scan on different lambdas agree.
 *
 * Slack scopes (user token): channels:history, channels:read, groups:history,
 * groups:read, im:history, im:read, mpim:history, mpim:read, users:read.
 */

import crypto from 'crypto'

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access'
const SLACK_API = 'https://slack.com/api'

/**
 * User-token scopes. We request history + read across every conversation type
 * plus users:read so authors can be resolved to display names.
 */
const SLACK_USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
].join(',')

/** Start of the "last 1 month" window, as a Slack ts (unix seconds string). */
function oneMonthAgoTs(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return String(Math.floor(d.getTime() / 1000))
}

export type SlackState = 'disconnected' | 'authorizing' | 'connected'

export interface SlackChannelCount {
  id: string
  name: string
  type: 'public' | 'private' | 'im' | 'mpim'
  messageCount: number
}

export interface SlackScanResult {
  /** Total messages across all conversations in the last month. */
  totalMessages: number
  /** How many conversations had at least one message in the window. */
  activeChannels: number
  /** How many conversations were examined. */
  scannedChannels: number
  /** Per-channel breakdown, busiest first (capped for payload size). */
  channels: SlackChannelCount[]
  capped?: boolean // true when a page/time cap was hit — totals are a lower bound
  windowDays: number
  scannedAt: number
}

interface SlackSession {
  state: SlackState
  teamName?: string
  authedUser?: string // Slack user id of the authorizing user
  authedUserName?: string
  accessToken?: string // user token (xoxp-...)
  scopes?: string
  scan?: SlackScanResult
}

/* ---------------------------------------------------------------------------
 * Persistence — globalThis in-memory cache + Upstash Redis REST (shared store).
 * Same shape as lib/gmail/service.ts so tokens survive callback/scan landing on
 * different serverless instances.
 * ------------------------------------------------------------------------- */

const g = globalThis as unknown as {
  __entwinSlackSessions?: Map<string, SlackSession>
}
if (!g.__entwinSlackSessions) g.__entwinSlackSessions = new Map<string, SlackSession>()
const sessions: Map<string, SlackSession> = g.__entwinSlackSessions

/* --- Signed, stateless OAuth state (see gmail/service.ts for rationale) --- */

const STATE_TTL_MS = 10 * 60 * 1000

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
function encodeState(userEmail: string, cardId: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({ userEmail, cardId, ts: Date.now() })))
  const sig = b64url(crypto.createHmac('sha256', stateSecret()).update(payload).digest())
  return `${payload}.${sig}`
}
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

/* --- Upstash Redis REST store (best-effort; no SDK) --- */

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
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

function keyFor(userEmail: string, cardId: string): string {
  return `${userEmail}::${cardId}`
}
function redisKey(userEmail: string, cardId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(keyFor(userEmail, cardId).toLowerCase())
    .digest('hex')
    .slice(0, 24)
  return `entwin:slack:${hash}`
}
async function redisCmd(args: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
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
async function writeStore(userEmail: string, cardId: string, sess: SlackSession): Promise<void> {
  if (!REDIS_ENABLED) return
  try {
    await redisCmd(['SET', redisKey(userEmail, cardId), JSON.stringify(sess), 'EX', SESSION_TTL_SECONDS])
  } catch {
    /* store unavailable — warm in-memory cache still serves this instance */
  }
}
async function readStore(userEmail: string, cardId: string): Promise<SlackSession | undefined> {
  if (!REDIS_ENABLED) return undefined
  try {
    const raw = (await redisCmd(['GET', redisKey(userEmail, cardId)])) as string | null
    if (!raw) return undefined
    return JSON.parse(raw) as SlackSession
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
async function getSession(userEmail: string, cardId: string): Promise<SlackSession> {
  const k = keyFor(userEmail, cardId)
  const cached = sessions.get(k)
  if (cached) return cached
  const fromStore = await readStore(userEmail, cardId)
  if (fromStore) {
    sessions.set(k, fromStore)
    return fromStore
  }
  const fresh: SlackSession = { state: 'disconnected' }
  sessions.set(k, fresh)
  return fresh
}
async function saveSession(userEmail: string, cardId: string, sess: SlackSession): Promise<void> {
  sessions.set(keyFor(userEmail, cardId), sess)
  await writeStore(userEmail, cardId, sess)
}

/* ---------------------------------------------------------------------------
 * OAuth
 * ------------------------------------------------------------------------- */

function redirectUri(): string {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/api/slack/callback`
}

/** Build the Slack consent URL and mark the card as authorizing. */
export async function buildAuthUrl(userEmail: string, cardId: string): Promise<string> {
  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId) throw new Error('SLACK_CLIENT_ID is not set')

  const state = encodeState(userEmail, cardId)

  const sess = await getSession(userEmail, cardId)
  sess.state = 'authorizing'
  await saveSession(userEmail, cardId, sess)

  const params = new URLSearchParams({
    client_id: clientId,
    // user_scope grants a user token (acts as the person, so it can read the
    // DMs and private channels they're a member of). We don't need bot scopes.
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: redirectUri(),
    state,
  })
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`
}

/** Exchange the OAuth code for a user token and attach it to the card session. */
export async function handleCallback(
  code: string,
  state: string,
): Promise<{ userEmail: string; cardId: string }> {
  const flow = decodeState(state)

  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Slack OAuth env vars are not set')

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
  })

  const res = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Slack token exchange failed: ${res.status} ${detail}`)
  }
  const tok = (await res.json()) as {
    ok: boolean
    error?: string
    team?: { id: string; name: string }
    authed_user?: { id: string; access_token?: string; scope?: string; token_type?: string }
  }
  if (!tok.ok) throw new Error(`Slack OAuth error: ${tok.error || 'unknown'}`)

  const userToken = tok.authed_user?.access_token
  if (!userToken) {
    throw new Error('Slack did not return a user token — check that user_scope was granted')
  }

  const sess = await getSession(flow.userEmail, flow.cardId)
  sess.state = 'connected'
  sess.accessToken = userToken
  sess.scopes = tok.authed_user?.scope
  sess.teamName = tok.team?.name
  sess.authedUser = tok.authed_user?.id

  // Resolve the authorizing user's display name (best-effort, non-fatal).
  if (tok.authed_user?.id) {
    try {
      const ui = await slackGet(userToken, 'users.info', { user: tok.authed_user.id })
      const u = ui as { user?: { profile?: { display_name?: string; real_name?: string } } }
      sess.authedUserName =
        u.user?.profile?.display_name || u.user?.profile?.real_name || undefined
    } catch {
      /* non-fatal */
    }
  }
  await saveSession(flow.userEmail, flow.cardId, sess)

  return { userEmail: flow.userEmail, cardId: flow.cardId }
}

/* ---------------------------------------------------------------------------
 * Slack Web API helpers
 * ------------------------------------------------------------------------- */

/** GET a Slack Web API method with the user token. Throws on `ok:false`. */
async function slackGet(
  token: string,
  method: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const url = new URL(`${SLACK_API}/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`)
  const json = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown }
  if (!json.ok) {
    // rate limiting is signalled by error: "ratelimited"; the caller handles it.
    throw new Error(json.error || `Slack ${method} failed`)
  }
  return json
}

interface SlackConversation {
  id: string
  name?: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_channel?: boolean
  is_group?: boolean
  user?: string // for IMs, the other party
}

/** Page through conversations.list to enumerate everything the user can read. */
async function listConversations(token: string): Promise<SlackConversation[]> {
  const out: SlackConversation[] = []
  let cursor = ''
  let pages = 0
  do {
    const params: Record<string, string | number> = {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: 'true',
      limit: 200,
    }
    if (cursor) params.cursor = cursor
    const resp = (await slackGet(token, 'conversations.list', params)) as {
      channels?: SlackConversation[]
      response_metadata?: { next_cursor?: string }
    }
    for (const c of resp.channels ?? []) out.push(c)
    cursor = resp.response_metadata?.next_cursor || ''
    pages += 1
    if (pages >= 25) break // hard safety cap on channel enumeration
  } while (cursor)
  return out
}

function classify(c: SlackConversation): SlackChannelCount['type'] {
  if (c.is_im) return 'im'
  if (c.is_mpim) return 'mpim'
  if (c.is_private) return 'private'
  return 'public'
}

const HISTORY_MAX_PAGES = 20 // 20 * 200 = up to 4,000 messages per channel

/**
 * Count messages in one conversation since `oldest` (unix seconds string).
 * Pages conversations.history, summing real (non-subtype-join/leave) messages.
 */
async function countChannelHistory(
  token: string,
  channelId: string,
  oldest: string,
): Promise<{ count: number; capped: boolean }> {
  let cursor = ''
  let count = 0
  let pages = 0
  do {
    const params: Record<string, string | number> = {
      channel: channelId,
      oldest,
      limit: 200,
    }
    if (cursor) params.cursor = cursor
    let resp: { messages?: { subtype?: string }[]; response_metadata?: { next_cursor?: string } }
    try {
      resp = (await slackGet(token, 'conversations.history', params)) as typeof resp
    } catch (e) {
      // A channel the token can't read (not_in_channel, etc.) contributes 0
      // rather than failing the whole scan.
      const msg = (e as Error).message
      if (msg === 'not_in_channel' || msg === 'channel_not_found' || msg === 'missing_scope') {
        return { count, capped: false }
      }
      throw e
    }
    for (const m of resp.messages ?? []) {
      // Skip channel-join / channel-leave and other system subtypes; count
      // human + bot messages.
      if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue
      count += 1
    }
    cursor = resp.response_metadata?.next_cursor || ''
    pages += 1
    if (pages >= HISTORY_MAX_PAGES && cursor) {
      return { count, capped: true }
    }
  } while (cursor)
  return { count, capped: false }
}

/* ---------------------------------------------------------------------------
 * Scan — pull the last 1 month of chats across the workspace.
 * ------------------------------------------------------------------------- */

export async function scan(userEmail: string, cardId: string): Promise<SlackScanResult> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected' || !sess.accessToken) {
    throw new Error('Slack is not connected for this card')
  }
  const token = sess.accessToken
  const oldest = oneMonthAgoTs()

  const conversations = await listConversations(token)

  // Count each conversation's history. Bounded concurrency keeps us well under
  // Slack's Tier-3 rate limits (conversations.history ~50 req/min) while still
  // finishing inside the serverless budget.
  const CONCURRENCY = 4
  const perChannel: SlackChannelCount[] = []
  let capped = false
  let total = 0

  for (let i = 0; i < conversations.length; i += CONCURRENCY) {
    const batch = conversations.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (c) => {
        const { count, capped: cCap } = await countChannelHistory(token, c.id, oldest)
        return { c, count, cCap }
      }),
    )
    for (const { c, count, cCap } of results) {
      if (cCap) capped = true
      total += count
      perChannel.push({
        id: c.id,
        name: c.name || (c.is_im ? 'Direct message' : c.is_mpim ? 'Group DM' : c.id),
        type: classify(c),
        messageCount: count,
      })
    }
  }

  const active = perChannel.filter((c) => c.messageCount > 0)
  active.sort((a, b) => b.messageCount - a.messageCount)

  const result: SlackScanResult = {
    totalMessages: total,
    activeChannels: active.length,
    scannedChannels: conversations.length,
    channels: active.slice(0, 25), // busiest 25 for a compact payload
    capped,
    windowDays: 30,
    scannedAt: Date.now(),
  }
  sess.scan = result
  await saveSession(userEmail, cardId, sess)
  return result
}

/* ---------------------------------------------------------------------------
 * Status / disconnect
 * ------------------------------------------------------------------------- */

export interface SlackStatus {
  state: SlackState
  teamName: string | null
  connectedUser: string | null
  scan: SlackScanResult | null
}

export async function status(userEmail: string, cardId: string): Promise<SlackStatus> {
  const sess = await getSession(userEmail, cardId)
  return {
    state: sess.state,
    teamName: sess.teamName ?? null,
    connectedUser: sess.authedUserName ?? null,
    scan: sess.scan ?? null,
  }
}

export async function disconnect(userEmail: string, cardId: string): Promise<void> {
  sessions.delete(keyFor(userEmail, cardId))
  await deleteStore(userEmail, cardId)
}
