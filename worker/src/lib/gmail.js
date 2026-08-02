// Gmail access via the raw REST API (same approach as the frontend's
// lib/gmail/service.ts — no googleapis SDK dependency).
import { saveGmailSession } from './redis.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Ensure a valid access token, refreshing via the stored refresh_token.
// Persists the refreshed token back to Redis so future runs reuse it.
export async function ensureAccessToken(userEmail, cardId, session) {
  if (session.accessToken && session.expiresAt && Date.now() < session.expiresAt - 60_000) {
    return session.accessToken;
  }
  if (!session.refreshToken) {
    if (session.accessToken) return session.accessToken;
    throw new Error('no refresh token; reconnect required');
  }
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const tok = await res.json();
  session.accessToken = tok.access_token;
  session.expiresAt = Date.now() + tok.expires_in * 1000;
  await saveGmailSession(userEmail, cardId, session);
  return session.accessToken;
}

async function gget(url, accessToken) {
  return withBackoff(async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const e = new Error(`gmail ${res.status}`);
      e.code = res.status;
      throw e;
    }
    return res.json();
  });
}

// Format a date as Gmail's search-friendly YYYY/MM/DD (raw epoch in `after:` is
// unreliable and silently drops results — this must match the scan's format).
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// Backfill: page message ids for a given label (INBOX or SENT), after a date.
// Enumerating PER LABEL with the same after:YYYY/MM/DD the scan uses is what
// makes the backfill's coverage match the scan's counts.
export async function* listMessageIds(accessToken, { afterDate, labelId, pageToken }) {
  let token = pageToken || undefined;
  const afterStr = ymd(afterDate);
  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set('q', `after:${afterStr}`);
    if (labelId) url.searchParams.set('labelIds', labelId);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('fields', 'messages/id,nextPageToken');
    if (token) url.searchParams.set('pageToken', token);
    const page = await gget(url.toString(), accessToken);
    const ids = (page.messages || []).map((m) => m.id);
    token = page.nextPageToken || null;
    yield { ids, nextPageToken: token, labelId };
  } while (token);
}

// Delta: messageAdded history since a historyId.
export async function historySince(accessToken, startHistoryId) {
  const changed = new Set();
  let pageToken;
  let latest = startHistoryId;
  do {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.append('historyTypes', 'messageAdded');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await gget(url.toString(), accessToken);
    for (const h of page.history || []) {
      latest = h.id || latest;
      for (const a of h.messagesAdded || []) if (a.message?.id) changed.add(a.message.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { ids: [...changed], latestHistoryId: latest };
}

export async function currentHistoryId(accessToken) {
  const p = await gget(`${GMAIL_API}/profile`, accessToken);
  return p.historyId;
}

export async function getMessage(accessToken, id) {
  return gget(`${GMAIL_API}/messages/${id}?format=full`, accessToken);
}

export function extractParts(message) {
  const headers = {};
  for (const h of message.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  let text = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (mime === 'text/plain' && part.body?.data) text += decodeB64(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decodeB64(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(message.payload);
  return {
    headers,
    text,
    html,
    labels: message.labelIds || [],
    threadId: message.threadId,
    internalDate: new Date(Number(message.internalDate)),
  };
}

function decodeB64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function withBackoff(fn, tries = 6) {
  let delay = 500;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err?.code;
      if (i === tries - 1 || ![429, 500, 502, 503, 504].includes(code)) throw err;
      await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
      delay *= 2;
    }
  }
}
