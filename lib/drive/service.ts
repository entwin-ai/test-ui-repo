/**
 * Google Drive connector service (server-side) — used by Chorale.
 *
 * What it does
 * ------------
 * Chorale (the voice recorder) needs to WRITE recordings into a folder the user
 * picks in their own Google Drive. Reading Gmail (the `gmail.readonly` scope
 * requested by lib/gmail/service.ts) does NOT grant that — writing a file needs
 * a Drive scope. So when the user clicks "Configure GDrive" we run a *separate*,
 * incremental consent for the Drive write scope, then let them browse their
 * Drive and choose a destination folder.
 *
 * Scope choice: `drive.file`.
 *   - `drive.file` grants per-file access to files the app creates or that the
 *     user explicitly opens with the app. It is the least-privilege scope that
 *     still lets Chorale create recording files in the chosen folder, and it is
 *     NOT a Google "restricted"/"sensitive" scope, so it doesn't require the
 *     heavier OAuth verification that full `drive` does. We can enumerate the
 *     folder tree the user navigates (folders are listable) and then write new
 *     recording files into the selected folder.
 *
 * The consent flow (per Chorale card):
 *   1. UI hits /api/drive/authorize?card=chorale-recorder -> we build a Google
 *      consent URL with prompt=select_account+consent (so the account chooser
 *      AND the permission screen always show — this is the "revalidate Gmail
 *      authentication for Drive write access" step), redirect to Google.
 *   2. Google redirects back to /api/drive/callback with a code.
 *   3. We exchange the code for tokens and store them per (user, cardId).
 *   4. UI opens the Drive Explorer, which calls /api/drive/folders to list
 *      folders (starting at "My Drive" root and drilling down), and on select
 *      persists the chosen folder id + name/path onto the connector.
 *
 * This file deliberately mirrors lib/gmail/service.ts (signed stateless OAuth
 * `state`, globalThis-pinned in-memory cache + optional Upstash Redis store) so
 * tokens survive a callback and a later folder-list landing on different
 * serverless instances. Only Drive-specific bits differ (the scope and the
 * folder-listing calls).
 */

import crypto from 'crypto'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'

export type DriveState = 'disconnected' | 'authorizing' | 'connected'

export interface DriveFolder {
  id: string
  name: string
}

/** A folder the user has committed to as the Chorale destination. */
export interface SelectedFolder {
  id: string
  name: string
  /** Human-readable path like "My Drive / Recordings / 2026". */
  path: string
}

interface DriveSession {
  state: DriveState
  connectedEmail?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // unix ms
  writeAccess?: boolean
  selectedFolder?: SelectedFolder
}

/* ---------------------------------------------------------------------------
 * Persistence — globalThis in-memory cache backed by optional Upstash Redis,
 * identical in shape to the Gmail service so it behaves the same on Vercel.
 * ------------------------------------------------------------------------- */

const g = globalThis as unknown as {
  __entwinDriveSessions?: Map<string, DriveSession>
}
if (!g.__entwinDriveSessions) g.__entwinDriveSessions = new Map<string, DriveSession>()
const sessions: Map<string, DriveSession> = g.__entwinDriveSessions

/* ---- signed, stateless OAuth `state` (see gmail/service.ts for rationale) --- */

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

/* ---- optional durable store (Upstash REST) -------------------------------- */

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
  return `entwin:drive:${hash}`
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
async function writeStore(userEmail: string, cardId: string, sess: DriveSession): Promise<void> {
  if (!REDIS_ENABLED) return
  try {
    await redisCmd(['SET', redisKey(userEmail, cardId), JSON.stringify(sess), 'EX', SESSION_TTL_SECONDS])
  } catch {
    /* best-effort */
  }
}
async function readStore(userEmail: string, cardId: string): Promise<DriveSession | undefined> {
  if (!REDIS_ENABLED) return undefined
  try {
    const raw = (await redisCmd(['GET', redisKey(userEmail, cardId)])) as string | null
    if (!raw) return undefined
    return JSON.parse(raw) as DriveSession
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

async function getSession(userEmail: string, cardId: string): Promise<DriveSession> {
  const k = keyFor(userEmail, cardId)
  const cached = sessions.get(k)
  if (cached) return cached
  const fromStore = await readStore(userEmail, cardId)
  if (fromStore) {
    sessions.set(k, fromStore)
    return fromStore
  }
  const fresh: DriveSession = { state: 'disconnected' }
  sessions.set(k, fresh)
  return fresh
}
async function saveSession(userEmail: string, cardId: string, sess: DriveSession): Promise<void> {
  sessions.set(keyFor(userEmail, cardId), sess)
  await writeStore(userEmail, cardId, sess)
}

/* ---------------------------------------------------------------------------
 * OAuth
 * ------------------------------------------------------------------------- */

function redirectUri(): string {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/api/drive/callback`
}

/**
 * Build the Google consent URL for Drive WRITE access and mark the flow as
 * authorizing. prompt=select_account+consent forces both the account chooser
 * and the permissions screen every time — that is the deliberate
 * "revalidate the user's Google authentication for Drive write access" step
 * the Chorale flow requires, so the user re-confirms which account and grants
 * write consent even if they've connected Gmail before.
 */
export async function buildAuthUrl(userEmail: string, cardId: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set')

  const state = encodeState(userEmail, cardId)

  const sess = await getSession(userEmail, cardId)
  sess.state = 'authorizing'
  await saveSession(userEmail, cardId, sess)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    // Identity + Drive write (per-file). include_granted_scopes keeps any Gmail
    // scope already granted on the same account.
    scope: `openid email ${DRIVE_SCOPE}`,
    prompt: 'select_account consent',
    access_type: 'offline',
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
    scope?: string
  }

  // Confirm the Drive write scope was actually granted. If the user unticked it
  // on the consent screen, `scope` won't contain it and we must not claim write
  // access.
  const grantedWrite = (tok.scope || '').includes(DRIVE_SCOPE)

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
  sess.writeAccess = grantedWrite
  await saveSession(flow.userEmail, flow.cardId, sess)

  return { userEmail: flow.userEmail, cardId: flow.cardId }
}

async function ensureAccessToken(
  userEmail: string,
  cardId: string,
  sess: DriveSession,
): Promise<string> {
  if (sess.accessToken && sess.expiresAt && Date.now() < sess.expiresAt - 60_000) {
    return sess.accessToken
  }
  if (!sess.refreshToken) {
    if (sess.accessToken) return sess.accessToken
    throw new Error('No valid Drive token; reconnect required')
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
  if (!res.ok) throw new Error('Failed to refresh Drive token')
  const tok = (await res.json()) as { access_token: string; expires_in: number }
  sess.accessToken = tok.access_token
  sess.expiresAt = Date.now() + tok.expires_in * 1000
  await saveSession(userEmail, cardId, sess)
  return sess.accessToken
}

/* ---------------------------------------------------------------------------
 * Folder listing (for the Drive Explorer)
 * ------------------------------------------------------------------------- */

/**
 * List the folders directly inside `parentId` ('root' == My Drive). Only
 * folders are returned (files are irrelevant when the user is choosing a
 * destination). trashed files are excluded. Results are name-sorted and paged
 * (Drive returns up to `pageSize`; we page until exhausted or a sane cap).
 */
export async function listFolders(
  userEmail: string,
  cardId: string,
  parentId: string = 'root',
): Promise<DriveFolder[]> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected') throw new Error('Drive is not connected for this card')
  const accessToken = await ensureAccessToken(userEmail, cardId, sess)

  const parent = parentId && parentId.trim() ? parentId.trim() : 'root'
  const folders: DriveFolder[] = []
  let pageToken: string | undefined
  let pages = 0
  const MAX_PAGES = 20 // up to 20 * 100 = 2000 folders under one parent

  do {
    const url = new URL(`${DRIVE_API}/files`)
    // Folders only, immediate children of `parent`, not trashed.
    url.searchParams.set(
      'q',
      `mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`,
    )
    url.searchParams.set('fields', 'files(id,name),nextPageToken')
    url.searchParams.set('orderBy', 'name')
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('spaces', 'drive')
    // Cover shared drives too, so the picker isn't limited to My Drive.
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Drive list failed: ${res.status} ${detail}`)
    }
    const page = (await res.json()) as {
      files?: { id: string; name: string }[]
      nextPageToken?: string
    }
    for (const f of page.files ?? []) folders.push({ id: f.id, name: f.name })
    pageToken = page.nextPageToken
    pages += 1
    if (pages >= MAX_PAGES) break
  } while (pageToken)

  return folders
}

/* ---------------------------------------------------------------------------
 * Selection / status / disconnect
 * ------------------------------------------------------------------------- */

/** Persist the user's chosen destination folder onto the card session. */
export async function selectFolder(
  userEmail: string,
  cardId: string,
  folder: SelectedFolder,
): Promise<void> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected') throw new Error('Drive is not connected for this card')
  sess.selectedFolder = folder
  await saveSession(userEmail, cardId, sess)
}

export interface DriveStatus {
  state: DriveState
  connectedEmail: string | null
  writeAccess: boolean
  selectedFolder: SelectedFolder | null
  storeConfigured: boolean
}

export async function status(userEmail: string, cardId: string): Promise<DriveStatus> {
  const sess = await getSession(userEmail, cardId)
  return {
    state: sess.state,
    connectedEmail: sess.connectedEmail ?? null,
    writeAccess: !!sess.writeAccess,
    selectedFolder: sess.selectedFolder ?? null,
    storeConfigured: REDIS_ENABLED,
  }
}

export async function disconnect(userEmail: string, cardId: string): Promise<void> {
  sessions.delete(keyFor(userEmail, cardId))
  await deleteStore(userEmail, cardId)
}
