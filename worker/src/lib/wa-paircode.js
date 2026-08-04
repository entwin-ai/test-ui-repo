// Publish the WhatsApp pairing code to Redis so the app UI can display it in the
// connectors tab, instead of the user having to open the GitHub Actions log.
//
// Key scheme mirrors the app's service.ts credsKey() — sha256(email).slice(0,24)
// — so the frontend reads exactly what the worker writes:
//   entwin:wa:paircode:<hash> -> JSON { code, pretty, phone, expiresAt }  (TTL)
//
// The code is only useful for a few minutes (WhatsApp expires it), so we set a
// TTL matching the pairing window and DELETE the key the moment the device
// links (or on force-repair), so a stale code never lingers in the UI.

import crypto from 'crypto';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN;
const ENABLED = Boolean(REDIS_URL && REDIS_TOKEN);

const CODE_TTL_S = Math.ceil(Number(process.env.WA_PAIR_TIMEOUT_MS || 300_000) / 1000);

function paircodeKey(userEmail) {
  const hash = crypto.createHash('sha256').update(userEmail.toLowerCase()).digest('hex').slice(0, 24);
  return `entwin:wa:paircode:${hash}`;
}

async function redisCmd(args) {
  if (!ENABLED) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result;
}

export async function publishPairCode(userEmail, code, phone) {
  const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
  const payload = JSON.stringify({
    code,
    pretty,
    phone,
    expiresAt: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
  });
  await redisCmd(['SET', paircodeKey(userEmail), payload, 'EX', CODE_TTL_S]);
}

export async function clearPairCode(userEmail) {
  await redisCmd(['DEL', paircodeKey(userEmail)]);
}
