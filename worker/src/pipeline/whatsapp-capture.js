import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { admin } from '../lib/supabase.js';
import { useRedisAuthState, hasCreds, clearAuthState } from '../lib/wa-auth-store.js';
import { createNameRegistry } from '../lib/wa-names.js';

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

// Initial-ingestion history depth: every chat is walked back to at least this
// far. 1 month by default, overridable. Used both as the persist floor and as
// the target for the per-chat on-demand history walk below.
const BACKFILL_DAYS = Number(process.env.WA_BACKFILL_DAYS || 30);
// On-demand history: how many messages to request per chat per fetch, and how
// many fetch rounds to allow before giving up on a chat (protects the run's
// time budget on very chatty conversations).
const HISTORY_PAGE = Number(process.env.WA_HISTORY_PAGE || 50);
const MAX_HISTORY_ROUNDS = Number(process.env.WA_HISTORY_ROUNDS || 12);
// A first-ever ingestion legitimately needs longer than the hourly delta drain.
const BACKFILL_DRAIN_MS = Number(process.env.WA_BACKFILL_DRAIN_MS || 300_000); // 5 min

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

function msgTsMs(m) {
  const raw = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp || 0);
  return raw ? raw * 1000 : 0;
}

// Build a ledger row, resolving names through the registry. `names` is a
// createNameRegistry() instance; `selfName` is the account owner's own display
// name (for `fromMe` messages).
function toRow(userEmail, m, names, selfName) {
  const text = extractText(m);
  if (!text) return null;
  const key = m.key;
  if (!key?.id || !key.remoteJid || isStatus(key.remoteJid)) return null;
  const tsMs = msgTsMs(m);
  if (!tsMs) return null;

  const chatJid = key.remoteJid;
  const isGroup = isJidGroup(chatJid);
  // sender jid: in a group it's the participant; in a 1:1 it's the chat itself
  // (or self, for fromMe).
  const senderJid = key.fromMe
    ? 'me'
    : key.participant || chatJid;

  return {
    user_email: userEmail,
    card_id: 'whatsapp',
    wa_msg_id: key.id,
    chat_id: chatJid,
    // Group subject vs the other party's name — never the last speaker's name.
    chat_name: names.resolveChatName(chatJid),
    sender: senderJid,
    // The actual person who sent THIS message, always populated.
    sender_name: names.resolveSenderName(m, selfName),
    from_me: !!key.fromMe,
    msg_timestamp: new Date(tsMs).toISOString(),
    body: text,
    is_group: isGroup,
  };
}

// Persist a batch of raw rows, honoring the history floor for this account.
// Idempotent on (user_email, wa_msg_id). We do NOT ignoreDuplicates here: names
// improve as the registry fills during a run (a later contacts.upsert can name a
// chat that was null earlier), so on conflict we UPDATE the name columns while
// leaving body/timestamp intact.
async function persistRows(rows, floorIso) {
  if (rows.length === 0) return 0;
  const filtered = floorIso ? rows.filter((r) => r.msg_timestamp >= floorIso) : rows;
  if (filtered.length === 0) return 0;
  // De-dupe within the batch by wa_msg_id, keeping the row with the most
  // resolved names (offline sync + on-demand history can repeat a message).
  const best = new Map();
  const score = (r) => (r.chat_name ? 1 : 0) + (r.sender_name ? 1 : 0);
  for (const r of filtered) {
    const prev = best.get(r.wa_msg_id);
    if (!prev || score(r) > score(prev)) best.set(r.wa_msg_id, r);
  }
  const unique = [...best.values()];
  let { error } = await admin
    .from('whatsapp_message')
    .upsert(unique, { onConflict: 'user_email,wa_msg_id' });

  // Resilience: if the DB/PostgREST schema cache doesn't yet know about a newer
  // optional column (e.g. is_group before migration 0008 is applied or its
  // schema cache has reloaded), don't fail the whole run — strip the offending
  // column and retry once. Names/body/timestamps still land; is_group backfills
  // later via the migration's UPDATE.
  if (error && /is_group/.test(error.message) && /schema cache|column/.test(error.message)) {
    console.warn('whatsapp_message: is_group not in schema cache — retrying without it');
    const stripped = unique.map(({ is_group, ...rest }) => rest);
    ({ error } = await admin
      .from('whatsapp_message')
      .upsert(stripped, { onConflict: 'user_email,wa_msg_id' }));
  }

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

  // Is this the first (backfill) ingestion for this account, or an hourly delta?
  const isBackfill = !acct.backfill_done;

  // The history floor: 1 month by default. On a first ingestion this is also the
  // target depth the per-chat walk drives every chat back to.
  const floorMs =
    (acct.wa_backfill_after ? Date.parse(acct.wa_backfill_after) : NaN) ||
    Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const floorIso = new Date(floorMs).toISOString();

  const drainCeiling = isBackfill ? BACKFILL_DRAIN_MS : MAX_DRAIN_MS;

  const { state, saveCreds, flush } = await useRedisAuthState(userEmail);
  const names = createNameRegistry();

  const buffer = [];
  let captured = 0;

  return await new Promise((resolve) => {
    let done = false;
    let quietTimer = null;
    let hardTimer = null;
    let reconnects = 0;
    const MAX_RECONNECTS = 5;
    let sock = null;
    let selfName = null;

    // Per-chat bookkeeping for the on-demand backfill walk. For each chat we
    // remember the OLDEST message key/timestamp we've seen, and how many
    // on-demand rounds we've spent on it.
    const oldest = new Map(); // chatJid -> { key, tsMs }
    const rounds = new Map(); // chatJid -> number
    const satisfied = new Set(); // chats that reached the floor or ran dry

    const noteOldest = (m) => {
      const key = m?.key;
      const chatJid = key?.remoteJid;
      const tsMs = msgTsMs(m);
      if (!chatJid || !tsMs || isStatus(chatJid)) return;
      const cur = oldest.get(chatJid);
      if (!cur || tsMs < cur.tsMs) oldest.set(chatJid, { key, tsMs });
    };

    const collect = (msgs) => {
      for (const m of msgs) {
        names.ingestMessage(m);
        noteOldest(m);
        const row = toRow(userEmail, m, names, selfName);
        if (row) buffer.push(row);
      }
      bumpQuiet();
    };

    function bumpQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(onQuiet, QUIET_MS);
    }

    // When the stream goes quiet: on a delta run we're done. On a backfill run
    // we first try to pull each chat further back toward the floor via
    // on-demand history; only when every chat is satisfied do we finish.
    async function onQuiet() {
      if (done) return;
      if (!isBackfill) return finish('quiet');
      const requested = await driveBackfill();
      if (requested === 0) return finish('backfill-complete');
      // Requested more history for at least one chat — wait for it to arrive,
      // which will bump the quiet timer again when it does. Set a fallback in
      // case the phone returns nothing.
      bumpQuiet();
    }

    // For every chat whose oldest message is still newer than the floor, ask
    // WhatsApp for an older page. Returns how many on-demand requests we issued.
    async function driveBackfill() {
      if (!sock || typeof sock.fetchMessageHistory !== 'function') return 0;
      let requested = 0;
      for (const [chatJid, o] of oldest.entries()) {
        if (satisfied.has(chatJid)) continue;
        // Reached a month back for this chat — done.
        if (o.tsMs <= floorMs) { satisfied.add(chatJid); continue; }
        const r = rounds.get(chatJid) || 0;
        if (r >= MAX_HISTORY_ROUNDS) { satisfied.add(chatJid); continue; }
        rounds.set(chatJid, r + 1);
        try {
          // Pull older messages before the oldest we currently hold.
          await sock.fetchMessageHistory(HISTORY_PAGE, o.key, o.tsMs);
          requested += 1;
        } catch (e) {
          // Chat can't be paged further (e.g. no more server history) — stop.
          satisfied.add(chatJid);
        }
      }
      return requested;
    }

    const finish = async (reason) => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      let persistOk = false;
      try {
        captured = await persistRows(buffer, floorIso);
        persistOk = true;
      } catch (e) {
        console.error(`[${userEmail}/wa] persist failed:`, e.message);
      }
      // Mark the account backfilled ONLY if the persist actually succeeded AND
      // we buffered something (an empty first run means we never really synced —
      // don't burn the one-time backfill pass on a failed/empty run).
      const backfilledSomething = persistOk && buffer.length > 0;
      if (
        isBackfill &&
        backfilledSomething &&
        (reason === 'backfill-complete' || reason === 'quiet')
      ) {
        try {
          await admin
            .from('sync_state')
            .update({
              backfill_done: true,
              wa_backfill_after: floorIso,
              wa_last_processed_ts: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', acct.id);
        } catch (e) {
          console.error(`[${userEmail}/wa] sync_state update failed:`, e.message);
        }
      } else if (isBackfill && !backfilledSomething) {
        console.warn(
          `[${userEmail}/wa] backfill NOT marked complete (persistOk=${persistOk}, ` +
          `buffered=${buffer.length}) — will retry on next run`
        );
      }
      try {
        await flush(); // write rotated creds/keys back to Redis
      } catch (e) {
        console.error(`[${userEmail}/wa] cred flush failed:`, e.message);
      }
      try {
        sock?.end(undefined); // close socket; do NOT logout (keeps the link)
      } catch {}
      const sizes = names._sizes();
      console.log(
        `[${userEmail}/wa] capture done (${reason}) — ${captured} rows, ` +
        `${oldest.size} chats, names[contacts=${sizes.contacts},chats=${sizes.chats}]`
      );
      resolve({ captured });
    };

    // One overall ceiling across the whole run, including reconnects.
    hardTimer = setTimeout(() => finish('ceiling'), drainCeiling);

    async function connect() {
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false, // stay passive; don't change presence
        // Ask the phone to push full history on a first connect; on hourly
        // deltas we only need what we missed.
        syncFullHistory: isBackfill,
        browser: Browsers.ubuntu('Chrome'),
      });

      selfName = sock.authState?.creds?.me?.name || selfName;

      sock.ev.on('creds.update', () => {
        selfName = sock.authState?.creds?.me?.name || selfName;
        return saveCreds();
      });

      // History payloads carry contacts + chats directories AND messages.
      sock.ev.on('messaging-history.set', ({ contacts, chats, messages }) => {
        names.ingestContacts(contacts || []);
        names.ingestChats(chats || []);
        collect(messages || []);
      });
      // Live/near-live directory updates.
      sock.ev.on('contacts.upsert', (contacts) => names.ingestContacts(contacts || []));
      sock.ev.on('contacts.update', (contacts) => names.ingestContacts(contacts || []));
      sock.ev.on('chats.upsert', (chats) => names.ingestChats(chats || []));
      sock.ev.on('groups.upsert', (groups) => {
        for (const g of groups || []) names.ingestGroupMetadata(g);
      });
      sock.ev.on('messages.upsert', ({ messages }) => collect(messages || []));

      sock.ev.on('connection.update', (u) => {
        if (done) return;
        const { connection, lastDisconnect } = u;

        if (connection === 'open') {
          selfName = sock.authState?.creds?.me?.name || selfName;
          // Connected. Start the quiet clock; offline-sync events will keep
          // pushing it out until the backlog is drained (and, on backfill, until
          // the per-chat history walk is satisfied).
          bumpQuiet();
          return;
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : undefined);

          if (code === DisconnectReason.loggedOut) {
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
          // and occasionally drops (428) before the session opens. Reconnect
          // through these, reusing the shared registered auth state.
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

          finish(`closed-${code ?? 'unknown'}`);
        }
      });
    }

    connect().catch(() => finish('connect-error'));
  });
}
