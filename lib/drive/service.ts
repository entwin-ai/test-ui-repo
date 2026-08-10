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
 * Scope choice: full `drive`.
 *   - Chorale's "Configure GDrive" lets the user PASTE a link to an existing
 *     Drive folder (typically a shared-drive folder) that Entwin should write
 *     recordings into. Resolving that folder by id (GET /files/{id}) and
 *     confirming write access requires the app to SEE a folder it did not
 *     create. The narrower `drive.file` scope cannot do this — it only sees
 *     files the app created or that the user opens via Google's native picker,
 *     so a pasted folder returns 404. Full `drive` is therefore required to
 *     both resolve the pasted folder and create recording files inside it.
 *   - Note: full `drive` is a Google "restricted" scope. For production use
 *     with external users the OAuth consent screen must pass Google's
 *     restricted-scope verification (or the user must be a listed test user /
 *     internal Workspace user). This is the trade-off for URL-based folder
 *     selection; if you prefer to avoid restricted-scope verification, switch
 *     back to `drive.file` and select folders through the Drive Explorer picker
 *     instead of a pasted URL.
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
import {
  upsertConnectorState,
  getConnectorState,
  type ConnectorKey,
} from '@/lib/connectors/state'

// Full Drive scope. `drive.file` is narrower and preferable, BUT it can only
// see files/folders the app itself created or that the user hands over through
// Google's native file-picker. Chorale's "Configure GDrive" flow instead lets
// the user PASTE a link to an existing (often shared-drive) folder, and
// resolving that folder by id — GET /files/{id} — returns 404 under drive.file
// no matter how the folder is shared. To both resolve a pasted folder by id and
// write recordings into it, we need full `drive`.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
// Read-only scope for the INGEST cards (drive-personal / drive-professional).
// Unlike Chorale's write flow, ingestion only ever READS files inside selected
// folders (Read Me §1 Scope), so it asks for the least privilege that still lets
// it browse folders, read metadata, and download/export file bytes. Full
// (readonly) is used rather than drive.file because — exactly as the write flow
// notes — drive.file can only see files the app created or the user hands over
// via Google's native picker, which can't browse an arbitrary existing folder
// tree. drive.readonly is Google-"restricted" and needs consent-screen
// verification for external users, the same trade-off already accepted here.
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
// Cards whose Connect runs the READ/INGEST flow (not Chorale's write flow).
const INGEST_CARDS = new Set(['drive-personal', 'drive-professional'])
function scopeForCard(cardId: string): string {
  return INGEST_CARDS.has(cardId) ? DRIVE_READONLY_SCOPE : DRIVE_SCOPE
}
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
  /** Whether the token carries at least drive.readonly (the ingest cards). */
  readAccess?: boolean
  /**
   * Folders the user picked as ingestion roots for an INGEST card (Read Me §1
   * Scope). Multiple allowed (My Drive subfolder + a Shared Drive folder, …).
   * Chorale uses the single `selectedFolder` above; ingest cards use this list.
   */
  ingestFolders?: SelectedFolder[]
  /**
   * The raw OAuth `scope` string Google granted for this token. Used to detect
   * a stale token minted under an older, narrower scope (e.g. drive.file) so we
   * can force re-consent to pick up the current DRIVE_SCOPE instead of failing
   * with a confusing 404 when resolving a pasted folder.
   */
  grantedScope?: string
  selectedFolder?: SelectedFolder
  /**
   * Chorale "Turn-on Recorder" state. When armed, Chorale watches the selected
   * Google Drive folder (the Meet Recordings folder) for new native Meet
   * recordings and dispatches each to Babelscribe. Note: arming does NOT start
   * or force any recording — Meet only writes an artifact when a host turns on
   * recording in the call (eligible paid tiers). This flag only controls
   * whether Chorale ingests those artifacts.
   */
  recorderArmed?: boolean
  /**
   * Drive file ids we've already dispatched to Babelscribe, so a repeated scan
   * of the same folder doesn't re-transcribe the same recording. Capped to a
   * sane recent window in scanRecordings() to bound growth.
   */
  seenRecordingIds?: string[]
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
function encodeState(userEmail: string, cardId: string, pendingFolderUrl?: string): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ userEmail, cardId, pendingFolderUrl, ts: Date.now() })),
  )
  const sig = b64url(crypto.createHmac('sha256', stateSecret()).update(payload).digest())
  return `${payload}.${sig}`
}
function decodeState(state: string): {
  userEmail: string
  cardId: string
  pendingFolderUrl?: string
} {
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
    pendingFolderUrl?: string
    ts: number
  }
  if (!claims.ts || Date.now() - claims.ts > STATE_TTL_MS) {
    throw new Error('OAuth state expired — please try connecting again')
  }
  return { userEmail: claims.userEmail, cardId: claims.cardId, pendingFolderUrl: claims.pendingFolderUrl }
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
export async function buildAuthUrl(
  userEmail: string,
  cardId: string,
  pendingFolderUrl?: string,
): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set')

  const state = encodeState(userEmail, cardId, pendingFolderUrl)

  const sess = await getSession(userEmail, cardId)
  sess.state = 'authorizing'
  await saveSession(userEmail, cardId, sess)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    // Identity + the right Drive scope for this card: readonly for the ingest
    // cards, full write for Chorale. include_granted_scopes keeps any Gmail
    // scope already granted on the same account.
    scope: `openid email ${scopeForCard(cardId)}`,
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
): Promise<{
  userEmail: string
  cardId: string
  pendingFolderUrl?: string
  pendingFolderSaved?: boolean
  pendingFolderError?: string
}> {
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
  // Read access is granted by EITHER the full write scope or the readonly scope
  // (write implies read). The ingest cards only need this.
  const grantedRead =
    grantedWrite || (tok.scope || '').includes(DRIVE_READONLY_SCOPE)

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
  sess.readAccess = grantedRead
  sess.grantedScope = tok.scope || ''
  await saveSession(flow.userEmail, flow.cardId, sess)

  // If the user kicked off this consent from the "Configure GDrive" URL modal,
  // a folder URL rode along in the signed state. Now that we hold a write token,
  // resolve + verify it and persist it as the Chorale destination so the user
  // doesn't have to re-enter it after returning from Google.
  let pendingFolderSaved: boolean | undefined
  let pendingFolderError: string | undefined
  if (flow.pendingFolderUrl) {
    if (!grantedWrite) {
      pendingFolderError = 'Drive write access was not granted on the consent screen.'
    } else {
      try {
        const r = await selectFolderByUrl(flow.userEmail, flow.cardId, flow.pendingFolderUrl)
        pendingFolderSaved = !r.needsAuth && !!r.selectedFolder
        if (!pendingFolderSaved) pendingFolderError = 'Folder could not be saved.'
      } catch (e) {
        // Surface the real reason (bad link, 404/not visible, no write access)
        // back to the UI instead of a generic message.
        pendingFolderError = (e as Error).message
      }
    }
  }

  return {
    userEmail: flow.userEmail,
    cardId: flow.cardId,
    pendingFolderUrl: flow.pendingFolderUrl,
    pendingFolderSaved,
    pendingFolderError,
  }
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
 * Meet native-recording ingest
 *
 * Chorale doesn't record Meet calls itself. Instead, when Meet's native
 * recording is turned on in a call (host action, eligible paid tier), Google
 * writes the .mp4 (and optional transcript Doc) into the organizer's Drive
 * under "Meet Recordings", typically in a per-meeting subfolder. Here we watch
 * the folder the user configured and pick up NEW recording files so they can be
 * dispatched to Babelscribe for transcription.
 * ------------------------------------------------------------------------- */

/** A recording-like file discovered under the watched folder. */
export interface DriveRecordingFile {
  id: string
  name: string
  mimeType: string
  /** Drive createdTime (RFC 3339), used only for recency sorting. */
  createdTime?: string
  /** The folder id it was found in (the watched root or a per-meeting subfolder). */
  parentId: string
}

/** Mime types Meet writes for a recording's media. We treat these as audio to
 *  transcribe. (The transcript Doc, a Google Doc, is intentionally excluded —
 *  Babelscribe works from the media.) */
const RECORDING_MIME_TYPES = new Set([
  'video/mp4',
  'audio/mp4',
  'audio/mpeg',
  'audio/x-m4a',
  'audio/m4a',
  'audio/webm',
  'video/webm',
])

/**
 * List recording media files directly inside `parentId`. Non-folder, non-
 * trashed files whose mimeType looks like recorded media. Shared-drive aware.
 */
async function listRecordingFilesIn(
  accessToken: string,
  parentId: string,
): Promise<DriveRecordingFile[]> {
  const files: DriveRecordingFile[] = []
  let pageToken: string | undefined
  let pages = 0
  const MAX_PAGES = 10

  do {
    const url = new URL(`${DRIVE_API}/files`)
    url.searchParams.set(
      'q',
      `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    )
    url.searchParams.set('fields', 'files(id,name,mimeType,createdTime),nextPageToken')
    url.searchParams.set('orderBy', 'createdTime desc')
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('spaces', 'drive')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Drive file list failed: ${res.status} ${detail}`)
    }
    const page = (await res.json()) as {
      files?: { id: string; name: string; mimeType: string; createdTime?: string }[]
      nextPageToken?: string
    }
    for (const f of page.files ?? []) {
      if (RECORDING_MIME_TYPES.has(f.mimeType)) {
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          createdTime: f.createdTime,
          parentId,
        })
      }
    }
    pageToken = page.nextPageToken
    pages += 1
    if (pages >= MAX_PAGES) break
  } while (pageToken)

  return files
}

/**
 * Arm / disarm Chorale's recorder for a card. Arming only enables ingest — it
 * does not (and cannot) start a Meet recording. Requires a connected session
 * with a selected destination folder.
 */
export async function setRecorderArmed(
  userEmail: string,
  cardId: string,
  armed: boolean,
): Promise<void> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected' || !sess.writeAccess) {
    throw new Error('Connect Google Drive with write access first (Configure GDrive).')
  }
  if (armed && !sess.selectedFolder) {
    throw new Error('Choose a Google Drive folder first (Configure GDrive).')
  }
  sess.recorderArmed = armed
  await saveSession(userEmail, cardId, sess)
}

export interface ScanResult {
  /** Recordings newly discovered on this scan (not seen before). */
  newRecordings: DriveRecordingFile[]
  /** Total recording media files currently visible under the watched tree. */
  totalSeen: number
  folderName: string | null
}

/**
 * Scan the configured folder (and its immediate per-meeting subfolders, which
 * is how Meet lays out "Meet Recordings/<meeting>/…") for recording media, and
 * return the ones we haven't seen before. Marking-as-seen is the CALLER's job
 * via markRecordingsDispatched(), so a scan that fails to dispatch doesn't lose
 * the recording.
 */
export async function scanRecordings(userEmail: string, cardId: string): Promise<ScanResult> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected' || !sess.writeAccess) {
    throw new Error('Drive is not connected for this card')
  }
  if (!sess.selectedFolder) {
    throw new Error('No folder selected for this card')
  }
  const accessToken = await ensureAccessToken(userEmail, cardId, sess)
  const rootId = sess.selectedFolder.id

  // Files directly in the watched folder + one level of subfolders (Meet's
  // per-meeting folders). One level deep is enough for the standard layout and
  // keeps the scan bounded.
  const found: DriveRecordingFile[] = []
  found.push(...(await listRecordingFilesIn(accessToken, rootId)))
  const subfolders = await listFolders(userEmail, cardId, rootId)
  for (const sub of subfolders) {
    found.push(...(await listRecordingFilesIn(accessToken, sub.id)))
  }

  // Dedup by id (a file can't appear twice, but subfolder overlaps are cheap to
  // guard against).
  const byId = new Map<string, DriveRecordingFile>()
  for (const f of found) byId.set(f.id, f)
  const all = [...byId.values()]

  const seen = new Set(sess.seenRecordingIds ?? [])
  const newRecordings = all.filter((f) => !seen.has(f.id))

  return { newRecordings, totalSeen: all.length, folderName: sess.selectedFolder.path }
}

/** Record that these recording ids have been handed to Babelscribe, so future
 *  scans skip them. Keeps only the most recent 500 ids to bound growth. */
export async function markRecordingsDispatched(
  userEmail: string,
  cardId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const sess = await getSession(userEmail, cardId)
  const merged = [...(sess.seenRecordingIds ?? []), ...ids]
  // De-dup, keep last 500.
  sess.seenRecordingIds = [...new Set(merged)].slice(-500)
  await saveSession(userEmail, cardId, sess)
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

export interface UploadedFile {
  id: string
  name: string
  webViewLink?: string
}

/**
 * Upload recorded audio (bytes) into the card's selected Drive folder using the
 * granted write token. Multipart upload: a small JSON metadata part (name +
 * parent folder) followed by the media bytes. Shared-drive aware.
 *
 * Used by Chorale's in-browser recorder to persist a finished recording to the
 * user's configured folder. Requires a connected session with write access and
 * a selected folder.
 */
export async function uploadRecordingToSelectedFolder(
  userEmail: string,
  cardId: string,
  file: { name: string; mimeType: string; bytes: Buffer },
): Promise<UploadedFile> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected' || !sess.writeAccess) {
    throw new Error('Drive is not connected with write access for this card')
  }
  if (!sess.selectedFolder) {
    throw new Error('No destination folder selected (Configure GDrive first)')
  }
  const accessToken = await ensureAccessToken(userEmail, cardId, sess)

  const boundary = `entwin${crypto.randomBytes(12).toString('hex')}`
  const metadata = {
    name: file.name,
    parents: [sess.selectedFolder.id],
  }

  // Build a multipart/related body by hand: metadata part + media part.
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${file.mimeType}\r\n\r\n`,
    'utf8',
  )
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([preamble, file.bytes, epilogue])

  const url = new URL('https://www.googleapis.com/upload/drive/v3/files')
  url.searchParams.set('uploadType', 'multipart')
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('fields', 'id,name,webViewLink')

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Drive upload failed: ${res.status} ${detail}`)
  }
  const f = (await res.json()) as { id: string; name: string; webViewLink?: string }
  return { id: f.id, name: f.name, webViewLink: f.webViewLink }
}

/**
 * Pull a Drive folder id out of a share URL the user pastes. Handles the common
 * shapes:
 *   - https://drive.google.com/drive/folders/<ID>?usp=sharing
 *   - https://drive.google.com/drive/u/0/folders/<ID>
 *   - https://drive.google.com/open?id=<ID>
 *   - https://drive.google.com/drive/folders/<ID>/…
 *   - a bare folder id
 * Shared-drive root URLs (…/drive/folders/<driveId>) and shared-drive item URLs
 * both carry an id here and are resolved the same way.
 */
export function parseFolderIdFromUrl(input: string): string | null {
  const raw = (input || '').trim()
  if (!raw) return null

  // Bare id (Drive ids are URL-safe base64-ish, typically 19–44 chars).
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw

  // …/folders/<ID>
  const folders = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/)
  if (folders) return folders[1]

  // …?id=<ID> or …&id=<ID>
  const idParam = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (idParam) return idParam[1]

  // …/d/<ID>/… (some copied links use the /d/ shape)
  const dShape = raw.match(/\/d\/([a-zA-Z0-9_-]{10,})/)
  if (dShape) return dShape[1]

  return null
}

/**
 * Fetch a folder's metadata (name + capabilities) so we can (a) confirm the id
 * really points to a folder Entwin can see, and (b) confirm Entwin has WRITE
 * access — Google reports this as capabilities.canAddChildren, i.e. whether the
 * app can create files inside it. Works for both My Drive and shared-drive
 * folders (supportsAllDrives=true).
 */
async function fetchFolderMeta(
  accessToken: string,
  folderId: string,
): Promise<{ id: string; name: string; mimeType: string; canAddChildren: boolean }> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(folderId)}`)
  url.searchParams.set('fields', 'id,name,mimeType,capabilities(canAddChildren)')
  url.searchParams.set('supportsAllDrives', 'true')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) {
    throw new Error(
      'That folder is not visible to Entwin. Share it with the connected Google account (Editor access) and try again.',
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Could not read that Drive folder: ${res.status} ${detail}`)
  }
  const f = (await res.json()) as {
    id: string
    name: string
    mimeType: string
    capabilities?: { canAddChildren?: boolean }
  }
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    canAddChildren: !!f.capabilities?.canAddChildren,
  }
}

export interface SelectByUrlResult {
  /** True when there is no connected Drive token yet — caller should run OAuth. */
  needsAuth: boolean
  selectedFolder?: SelectedFolder
}

/**
 * Resolve a pasted Google Drive folder URL to a concrete folder, verify Entwin
 * has WRITE access to it, and persist it as the Chorale destination.
 *
 * If the card has no connected Drive token yet, this returns { needsAuth: true }
 * WITHOUT throwing, so the caller can hand the user off to the Google consent
 * flow (carrying the URL through, so we re-resolve it automatically on return).
 */
export async function selectFolderByUrl(
  userEmail: string,
  cardId: string,
  folderUrl: string,
): Promise<SelectByUrlResult> {
  const folderId = parseFolderIdFromUrl(folderUrl)
  if (!folderId) {
    throw new Error(
      'That does not look like a Google Drive folder link. Paste a URL like https://drive.google.com/drive/folders/FOLDER_ID',
    )
  }

  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected' || !sess.writeAccess) {
    // No usable write token yet — tell the caller to authorize first.
    return { needsAuth: true }
  }
  // A token minted under an older, narrower scope (e.g. drive.file from a
  // previous connect) cannot resolve a pasted folder by id and would 404. If the
  // stored scope doesn't include the scope we now require, force re-consent so
  // the flow re-runs OAuth (which requests the current DRIVE_SCOPE) and then
  // auto-saves the folder on return.
  if (!sess.grantedScope || !sess.grantedScope.includes(DRIVE_SCOPE)) {
    return { needsAuth: true }
  }

  const accessToken = await ensureAccessToken(userEmail, cardId, sess)
  const meta = await fetchFolderMeta(accessToken, folderId)

  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That link points to a file, not a folder. Paste a link to a Drive folder.')
  }
  if (!meta.canAddChildren) {
    throw new Error(
      `Entwin can see “${meta.name}” but cannot write to it. Give the connected Google account Editor access to the shared folder, then try again.`,
    )
  }

  const folder: SelectedFolder = { id: meta.id, name: meta.name, path: meta.name }
  sess.selectedFolder = folder
  await saveSession(userEmail, cardId, sess)
  return { needsAuth: false, selectedFolder: folder }
}

export interface DriveStatus {
  state: DriveState
  connectedEmail: string | null
  writeAccess: boolean
  selectedFolder: SelectedFolder | null
  storeConfigured: boolean
  recorderArmed: boolean
}

export async function status(userEmail: string, cardId: string): Promise<DriveStatus> {
  const sess = await getSession(userEmail, cardId)
  return {
    state: sess.state,
    connectedEmail: sess.connectedEmail ?? null,
    writeAccess: !!sess.writeAccess,
    selectedFolder: sess.selectedFolder ?? null,
    storeConfigured: REDIS_ENABLED,
    recorderArmed: !!sess.recorderArmed,
  }
}

export async function disconnect(userEmail: string, cardId: string): Promise<void> {
  sessions.delete(keyFor(userEmail, cardId))
  await deleteStore(userEmail, cardId)
}

/* ===========================================================================
 * Drive INGEST support (Read Me — read/diff/download for drive-personal /
 * drive-professional). These sit alongside Chorale's write flow and reuse the
 * same session/token machinery above; they only READ.
 * ========================================================================= */

/** Public token accessor for the ingest pipeline (refreshes if near expiry). */
export async function getDriveAccessToken(userEmail: string, cardId: string): Promise<string> {
  const sess = await getSession(userEmail, cardId)
  if (sess.state !== 'connected') throw new Error('Drive is not connected for this card')
  return ensureAccessToken(userEmail, cardId, sess)
}

/** Persist the folders the user chose as ingestion roots for an ingest card. */
export async function setIngestFolders(
  userEmail: string,
  cardId: string,
  folders: SelectedFolder[],
): Promise<void> {
  // Durable source of truth: connector_state.settings.driveFolders (survives
  // serverless restarts, missing Redis, and is what the daily-scan cron reads).
  // Merge into the EXISTING settings so we don't reset the user's pollHours /
  // backfill knobs — upsertConnectorState replaces the whole settings object.
  const existing = await getConnectorState(userEmail, cardId as ConnectorKey).catch(() => null)
  await upsertConnectorState(userEmail, cardId as ConnectorKey, {
    connected: true,
    settings: { ...(existing?.settings ?? {}), driveFolders: folders },
  })
  // Best-effort fast mirror onto the OAuth session too (used within a single
  // request lifetime), but never the sole store.
  try {
    const sess = await getSession(userEmail, cardId)
    if (sess.state === 'connected') {
      sess.ingestFolders = folders
      await saveSession(userEmail, cardId, sess)
    }
  } catch {
    /* session mirror is optional */
  }
}

/** Read back the selected ingestion roots for a card (empty if none yet). */
export async function getIngestFolders(
  userEmail: string,
  cardId: string,
): Promise<SelectedFolder[]> {
  // Read from the durable store first; fall back to the session mirror only if
  // the DB has nothing (e.g. a very old session written before this change).
  try {
    const state = await getConnectorState(userEmail, cardId as ConnectorKey)
    const fromDb = state?.settings?.driveFolders
    if (fromDb && fromDb.length) {
      return fromDb.map((f) => ({ id: f.id, name: f.name, path: f.path || f.name }))
    }
  } catch {
    /* fall through to session mirror */
  }
  const sess = await getSession(userEmail, cardId)
  return sess.ingestFolders ?? []
}

/**
 * A file discovered under a selected folder, with the change-detection metadata
 * the ledger diff needs (Read Me §1). parentFolderId is the immediate parent so
 * the ledger can record which selected root it came from.
 */
export interface DriveFileEntry {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  version?: string
  md5Checksum?: string
  webViewLink?: string
  parentFolderId?: string
}

/**
 * Recursively enumerate every non-folder file inside `rootFolderId` and its
 * subfolders (Read Me §1 Scope — only inside a selected folder). Folders are
 * traversed but not returned as ingestible files. Shared-drive aware. Bounded
 * by page and depth caps so a pathological tree can't loop unbounded.
 */
export async function listFilesInFolderTree(
  accessToken: string,
  rootFolderId: string,
): Promise<DriveFileEntry[]> {
  const FOLDER_MIME = 'application/vnd.google-apps.folder'
  const out: DriveFileEntry[] = []
  const queue: string[] = [rootFolderId]
  const visited = new Set<string>()
  let foldersProcessed = 0
  const MAX_FOLDERS = 500 // depth+breadth guard

  while (queue.length && foldersProcessed < MAX_FOLDERS) {
    const parent = queue.shift() as string
    if (visited.has(parent)) continue
    visited.add(parent)
    foldersProcessed++

    let pageToken: string | undefined
    let pages = 0
    do {
      const url = new URL(`${DRIVE_API}/files`)
      url.searchParams.set('q', `'${parent}' in parents and trashed = false`)
      url.searchParams.set(
        'fields',
        'files(id,name,mimeType,modifiedTime,version,md5Checksum,webViewLink),nextPageToken',
      )
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('spaces', 'drive')
      url.searchParams.set('supportsAllDrives', 'true')
      url.searchParams.set('includeItemsFromAllDrives', 'true')
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Drive tree list failed: ${res.status} ${detail}`)
      }
      const page = (await res.json()) as {
        files?: {
          id: string
          name: string
          mimeType: string
          modifiedTime?: string
          version?: string
          md5Checksum?: string
          webViewLink?: string
        }[]
        nextPageToken?: string
      }
      for (const f of page.files ?? []) {
        if (f.mimeType === FOLDER_MIME) {
          queue.push(f.id) // recurse into subfolders
        } else {
          out.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            version: f.version,
            md5Checksum: f.md5Checksum,
            webViewLink: f.webViewLink,
            parentFolderId: parent,
          })
        }
      }
      pageToken = page.nextPageToken
      pages++
      if (pages >= 50) break
    } while (pageToken)
  }
  return out
}

/**
 * Download a Drive file's bytes. For a Google-native type pass `exportMime` and
 * we hit the /export endpoint (Docs->docx, Sheets->xlsx, Slides->pptx); for a
 * binary file leave it undefined and we use ?alt=media. Shared-drive aware.
 */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
  exportMime?: string,
): Promise<Uint8Array> {
  const url = exportMime
    ? `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Drive download failed (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}
