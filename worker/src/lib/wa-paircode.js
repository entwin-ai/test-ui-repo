// Publish the WhatsApp pairing code to Redis so the app UI can display it in the
// connectors tab, instead of the user having to open the GitHub Actions log.
//
// Key scheme mirrors the app's service.ts credsKey() — sha256(email).slice(0,24)
// — so the frontend reads exactly what the worker writes:
//   entwin:wa:paircode:<hash> -> JSON { code, phone, expiresAt }  (short TTL)
//
// The code is only useful for a few minutes (WhatsApp expires it), so we set a
// TTL matching the pairing window and DELETE the key the moment the device
// links (or the run ends), so a stale code never lingers in the UI.

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

// TTL: how long the code stays readable by the UI. Matches the pairing timeout
// (default 5 min) so it disappears when the code would have expired anyway.
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

/**
 * Publish the pairing code for the app to show. `code` is the raw code from
 * Baileys; we store both the raw and a pretty (dash-grouped) form plus an
 * absolute expiry so the UI can show a countdown. Best-effort: a Redis failure
 * must never break pairing itself, so callers should not await-throw on this.
 */
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

/** Remove the published code (call on successful link or at run end). */
export async function clearPairCode(userEmail) {
  await redisCmd(['DEL', paircodeKey(userEmail)]);
}
