import crypto from 'crypto';

// Reuse the EXACT key scheme the frontend uses in lib/gmail/service.ts so the
// worker reads the same session the OAuth callback wrote:
//   key = entwin:gmail:<sha256(`${userEmail}::${cardId}`.toLowerCase()).slice(0,24)>
//   value = JSON GmailSession { state, connectedEmail, accessToken, refreshToken, expiresAt, scan }
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN;

function redisKey(userEmail, cardId) {
  const hash = crypto
    .createHash('sha256')
    .update(`${userEmail}::${cardId}`.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `entwin:gmail:${hash}`;
}

async function redisCmd(args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result;
}

// Return the stored GmailSession for (userEmail, cardId), or null.
export async function getGmailSession(userEmail, cardId) {
  const raw = await redisCmd(['GET', redisKey(userEmail, cardId)]);
  if (!raw) return null;
  return JSON.parse(raw);
}

// Persist a refreshed access token back so it's reused across runs.
export async function saveGmailSession(userEmail, cardId, session) {
  const TTL = 30 * 24 * 60 * 60;
  await redisCmd(['SET', redisKey(userEmail, cardId), JSON.stringify(session), 'EX', TTL]);
}

// SCAN for all connected gmail sessions. Since the app hashes the key, the
// worker cannot enumerate (userEmail, cardId) from Redis alone — so the app
// also records which accounts exist in Supabase sync_state (created on connect).
// This helper remains for completeness / debugging.
export async function listGmailKeys() {
  const keys = [];
  let cursor = '0';
  do {
    const res = await redisCmd(['SCAN', cursor, 'MATCH', 'entwin:gmail:*', 'COUNT', 100]);
    cursor = res[0];
    keys.push(...res[1]);
  } while (cursor !== '0');
  return keys;
}
