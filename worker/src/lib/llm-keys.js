import crypto from 'crypto';

// Per-user LLM credentials, stored encrypted in the SAME Upstash Redis as the
// Gmail tokens. Shape stored (after decrypt):
//   { provider: 'claude'|'gemini'|'openai', model: string, apiKey: string }
//
// Encryption: AES-256-GCM with a key derived from ENTWIN_KEY_SECRET (a strong
// random string set as an env var / GitHub secret, shared by the app and the
// worker). The user's API key is never stored in plaintext and never returned
// to the browser after saving.

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN;

function encKey() {
  const s = process.env.ENTWIN_KEY_SECRET;
  if (!s) throw new Error('ENTWIN_KEY_SECRET is not set (required to decrypt LLM keys)');
  // Derive a stable 32-byte key from the secret.
  return crypto.createHash('sha256').update(s).digest();
}

function redisKey(userEmail) {
  const hash = crypto
    .createHash('sha256')
    .update(`llm::${userEmail}`.toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `entwin:llm:${hash}`;
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

export function decrypt(blob) {
  const [ivB64, tagB64, dataB64] = blob.split('.');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// Fetch and decrypt a user's LLM config, or null if none set.
export async function getLlmConfig(userEmail) {
  const raw = await redisCmd(['GET', redisKey(userEmail)]);
  if (!raw) return null;
  return decrypt(raw);
}
