import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { admin } from '../lib/supabase.js';
import { useRedisAuthState, hasCreds, clearAuthState } from '../lib/wa-auth-store.js';

// BOUNDED WhatsApp capture — the batch replacement for the persistent bridge.
//
// This runs inside the hourly GitHub Actions job. Per user it:
//   1. Loads the saved device credentials from Redis (paired once, out of band).
//   2. Opens a Baileys socket. On connect, WhatsApp replays the OFFLINE SYNC —
//      every message that arrived since this device last connected — plus, on a
//      first-ever connect, up to `syncFullHistory`.
//   3. Buffers those messages for a short, bounded drain window, then persists
//      them (idempotently) to the whatsapp_message ledger.
//   4. Saves any rotated credentials/keys back to Redis and closes the socket.
//
// No socket is held between runs. At an hourly cadence WhatsApp's offline buffer
// comfortably covers the gap, so nothing is missed. The heavy vectorize step
// (notes/entities/embeddings) is a SEPARATE phase run right after capture in the
// same job — see index.js MODE=whatsapp-sync.

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

// How long to keep the socket open per run, waiting for WhatsApp to finish
// pushing the offline backlog. We resolve early once the stream goes quiet.
const MAX_DRAIN_MS = Number(process.env.WA_DRAIN_MS || 90_000); // hard ceiling
const QUIET_MS = Number(process.env.WA_QUIET_MS || 8_000); // idle => backlog drained

const isStatus = (jid) => jid === 'status@broadcast';

function extractText(m) {
  const msg = m.message;
  if (!msg) return '';
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.ephemeralMessage?.message?.conversation ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

function toRow(userEmail, m) {
  const text = extractText(m);
  if (!text) return null;
  const key = m.key;
  if (!key?.id || !key.remoteJid || isStatus(key.remoteJid)) return null;
  const tsRaw = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp || 0);
  if (!tsRaw) return null;
  return {
    user_email: userEmail,
    card_id: 'whatsapp',
    wa_msg_id: key.id,
    chat_id: key.remoteJid,
    chat_name: m.pushName || null,
    sender: key.participant || key.remoteJid,
    sender_name: m.pushName || null,
    from_me: !!key.fromMe,
    msg_timestamp: new Date(tsRaw * 1000).toISOString(),
    body: text,
  };
}

// Persist a batch of raw rows, honoring the 1-month floor for this account.
// Idempotent: upsert on (user_email, wa_msg_id) with ignoreDuplicates, so the
// overlap between offline-sync replay and any prior run never double-inserts.
async function persistRows(rows, floorIso) {
  if (rows.length === 0) return 0;
  const filtered = floorIso ? rows.filter((r) => r.msg_timestamp >= floorIso) : rows;
  if (filtered.length === 0) return 0;
  // De-dupe within the batch by wa_msg_id (offline sync can repeat).
  const seen = new Set();
  const unique = [];
  for (const r of filtered) {
    if (seen.has(r.wa_msg_id)) continue;
    seen.add(r.wa_msg_id);
    unique.push(r);
  }
  const { error } = await admin
    .from('whatsapp_message')
    .upsert(unique, { onConflict: 'user_email,wa_msg_id', ignoreDuplicates: true });
  if (error) throw new Error(`whatsapp_message upsert: ${error.message}`);
  return unique.length;
}

/**
 * Run one bounded capture for a single account. `acct` is the sync_state row.
 * Returns { captured } — how many raw rows were written this run.
 *
 * Resolves when the backlog goes quiet (QUIET_MS with no new messages) or the
 * MAX_DRAIN_MS ceiling is hit, whichever comes first — then always disconnects.
 */
export async function captureWhatsapp(acct) {
  const userEmail = acct.user_email;

  const registered = await hasCreds(userEmail);
  if (!registered) {
    console.log(`[${userEmail}/wa] no registered credentials — pair once, skipping capture`);
    return { captured: 0, notPaired: true };
  }

  const floorIso =
    acct.wa_backfill_after || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { state, saveCreds, flush } = await useRedisAuthState(userEmail);

  const buffer = [];
  let captured = 0;

  return await new Promise((resolve) => {
    let done = false;
    let quietTimer = null;
    let hardTimer = null;
    let reconnects = 0;
    const MAX_RECONNECTS = 5;
    let sock = null;

    const collect = (msgs) => {
      for (const m of msgs) {
        const row = toRow(userEmail, m);
        if (row) buffer.push(row);
      }
      // Reset the quiet timer: as long as messages keep arriving, keep waiting.
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), QUIET_MS);
    };

    const finish = async (reason) => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try {
        captured = await persistRows(buffer, floorIso);
      } catch (e) {
        console.error(`[${userEmail}/wa] persist failed:`, e.message);
      }
      try {
        await flush(); // write rotated creds/keys back to Redis
      } catch (e) {
        console.error(`[${userEmail}/wa] cred flush failed:`, e.message);
      }
      try {
        sock?.end(undefined); // close socket; do NOT logout (keeps the link)
      } catch {}
      console.log(`[${userEmail}/wa] capture done (${reason}) — ${captured} rows`);
      resolve({ captured });
    };

    // One overall ceiling across the whole run, including reconnects.
    hardTimer = setTimeout(() => finish('ceiling'), MAX_DRAIN_MS);

    async function connect() {
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false, // stay passive; don't change presence
        // Full history only matters on a first connect after pairing. On
        // subsequent hourly runs WhatsApp just replays what we missed.
        syncFullHistory: !acct.backfill_done,
        browser: Browsers.ubuntu('Chrome'),
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('messaging-history.set', ({ messages }) => collect(messages || []));
      sock.ev.on('messages.upsert', ({ messages }) => collect(messages || []));

      sock.ev.on('connection.update', (u) => {
        if (done) return;
        const { connection, lastDisconnect } = u;

        if (connection === 'open') {
          // Connected. Start the quiet clock; offline-sync events will keep
          // pushing it out until the backlog is drained.
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish('quiet'), QUIET_MS);
          return;
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : undefined);

          if (code === DisconnectReason.loggedOut) {
            // The user unlinked the device from their phone. Purge creds so we
            // don't retry forever, and mark the account for re-pair.
            clearAuthState(userEmail).catch(() => {});
            admin
              .from('sync_state')
              .update({ backfill_done: false, updated_at: new Date().toISOString() })
              .eq('id', acct.id)
              .then(() => {}, () => {});
            finish('logged-out');
            return;
          }

          // WhatsApp requests a stream RESTART (515) right after a fresh pairing
          // and occasionally drops (428) before the session opens. On a bounded
          // run we MUST reconnect through these — otherwise the very first
          // capture never reaches `open`, never receives the offline-sync
          // history, and drains nothing (green job, zero rows). Reuse the shared
          // (now-registered) auth state; it carries the session to `open`.
          if (code === DisconnectReason.restartRequired || code === 515 || code === 428) {
            try { sock?.end(undefined); } catch {}
            if (reconnects >= MAX_RECONNECTS) {
              finish(`too-many-reconnects-${code}`);
              return;
            }
            reconnects += 1;
            setTimeout(() => { connect().catch(() => finish('reconnect-error')); }, 1500);
            return;
          }

          // Any other close: persist what we have and let the next hourly run
          // pick up the rest from the offline buffer.
          finish(`closed-${code ?? 'unknown'}`);
        }
      });
    }

    connect().catch(() => finish('connect-error'));
  });
}
