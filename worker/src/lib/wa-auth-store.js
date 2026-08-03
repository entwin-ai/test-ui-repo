import {
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';
import crypto from 'crypto';

// Durable Baileys auth state, backed by the SAME Upstash Redis used for Gmail
// tokens and LLM keys. This is what lets WhatsApp run as an hourly BATCH job in
// GitHub Actions: each run is a fresh, empty VM, so the device-link credentials
// cannot live on local disk (the old ENTWIN_DATA_DIR approach). Instead we load
// them from Redis at the start of a run and write back any rotated keys at the
// end.
//
// Baileys' auth state has two parts:
//   * creds  — the device identity (registered once during pairing). One blob.
//   * keys   — signal-protocol session/prekey material that ROTATES as messages
//              flow. Stored per (type, id).
//
// We mirror useMultiFileAuthState's contract (state.creds, state.keys.get/set +
// saveCreds) but persist to Redis. Serialization uses Baileys' BufferJSON so the
// binary key material round-trips through JSON safely.
//
// Key scheme (per user; card is always 'whatsapp'):
//   entwin:wa:creds:<hash>            -> JSON creds
//   entwin:wa:keys:<hash>            -> JSON map { "<type>-<id>": value, ... }
// where <hash> = sha256(userEmail.toLowerCase()).slice(0,24).

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN;

const TTL_SECONDS = 400 * 24 * 60 * 60; // ~13 months; a linked device lives long

function userHash(userEmail) {
  return crypto.createHash('sha256').update(String(userEmail).toLowerCase()).digest('hex').slice(0, 24);
}
function credsKey(userEmail) {
  return `entwin:wa:creds:${userHash(userEmail)}`;
}
function keysKey(userEmail) {
  return `entwin:wa:keys:${userHash(userEmail)}`;
}

async function redisCmd(args) {
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

async function redisGet(key) {
  const raw = await redisCmd(['GET', key]);
  return raw ?? null;
}
async function redisSet(key, value) {
  await redisCmd(['SET', key, value, 'EX', TTL_SECONDS]);
}
async function redisDel(key) {
  await redisCmd(['DEL', key]);
}

/** Does this user already have registered WhatsApp credentials? */
export async function hasCreds(userEmail) {
  const raw = await redisGet(credsKey(userEmail));
  if (!raw) return false;
  try {
    const creds = JSON.parse(raw, BufferJSON.reviver);
    return !!creds?.registered;
  } catch {
    return false;
  }
}

/** Remove a user's WhatsApp auth (used on disconnect / logout). */
export async function clearAuthState(userEmail) {
  await Promise.allSettled([redisDel(credsKey(userEmail)), redisDel(keysKey(userEmail))]);
}

/**
 * Build a Baileys-compatible auth state backed by Redis.
 * Returns { state, saveCreds, flush }.
 *   state     -> pass as makeWASocket({ auth: state })
 *   saveCreds -> bind to sock.ev.on('creds.update', saveCreds)
 *   flush     -> call once before the run exits to persist buffered key writes
 *
 * Key writes are buffered in memory during the run and flushed in a single
 * Redis SET at the end (keys can be written dozens of times during a sync;
 * batching avoids a Redis round-trip per write).
 */
export async function useRedisAuthState(userEmail) {
  const cRaw = await redisGet(credsKey(userEmail));
  const creds = cRaw ? JSON.parse(cRaw, BufferJSON.reviver) : initAuthCreds();

  const kRaw = await redisGet(keysKey(userEmail));
  const keyMap = kRaw ? JSON.parse(kRaw, BufferJSON.reviver) : {};
  let keysDirty = false;

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {};
        for (const id of ids) {
          let val = keyMap[`${type}-${id}`];
          if (val) {
            if (type === 'app-state-sync-key' && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(val);
            }
            out[id] = val;
          }
        }
        return out;
      },
      set: async (data) => {
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            const k = `${type}-${id}`;
            if (value) keyMap[k] = value;
            else delete keyMap[k];
          }
        }
        keysDirty = true;
      },
    },
  };

  const saveCreds = async () => {
    await redisSet(credsKey(userEmail), JSON.stringify(creds, BufferJSON.replacer));
  };

  const flush = async () => {
    const jobs = [];
    // Always persist creds on flush (cheap; guarantees the registered flag and
    // any late rotations land even if a creds.update was missed).
    jobs.push(redisSet(credsKey(userEmail), JSON.stringify(creds, BufferJSON.replacer)));
    if (keysDirty) {
      jobs.push(redisSet(keysKey(userEmail), JSON.stringify(keyMap, BufferJSON.replacer)));
    }
    await Promise.allSettled(jobs);
  };

  return { state, saveCreds, flush };
}
