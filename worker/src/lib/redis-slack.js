import crypto from 'crypto';

// Reuse the EXACT key scheme the frontend uses in lib/slack/service.ts so the
// worker reads the same session the OAuth callback wrote:
//   key = entwin:slack:<sha256(`${userEmail}::${cardId}`.toLowerCase()).slice(0,24)>
//   value = JSON SlackSession { state, teamName, authedUser, accessToken, ... }
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
  return `entwin:slack:${hash}`;
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

// Return the stored SlackSession for (userEmail, cardId), or null.
export async function getSlackSession(userEmail, cardId) {
  const raw = await redisCmd(['GET', redisKey(userEmail, cardId)]);
  if (!raw) return null;
  return JSON.parse(raw);
}
