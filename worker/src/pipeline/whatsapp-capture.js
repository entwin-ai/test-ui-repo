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

// BOUNDED WhatsApp capture — runs inside the hourly GitHub Actions job. Per user
// it loads saved creds, opens a short-lived socket, drains WhatsApp's offline
// backlog (and, on a first ingestion, walks each chat ~1 month back via
// on-demand history), persists to the whatsapp_message ledger, and exits.
// Vectorize is a separate phase after capture (index.js MODE=whatsapp-sync).

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

const MAX_DRAIN_MS = Number(process.env.WA_DRAIN_MS || 90_000); // hourly-delta ceiling
const QUIET_MS = Number(process.env.WA_QUIET_MS || 8_000);      // idle => backlog drained

// Initial-ingestion history depth: every chat is walked back to at least this
// far. Also the persist floor.
const BACKFILL_DAYS = Number(process.env.WA_BACKFILL_DAYS || 30);
const HISTORY_PAGE = Number(process.env.WA_HISTORY_PAGE || 50);
const MAX_HISTORY_ROUNDS = Number(process.env.WA_HISTORY_ROUNDS || 12);
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

// Build a ledger row, resolving names through the registry.
function toRow(userEmail, m, names, selfName) {
  const text = extractText(m);
  if (!text) return null;
  const key = m.key;
  if (!key?.id || !key.remoteJid || isStatus(key.remoteJid)) return null;
  const tsMs = msgTsMs(m);
  if (!tsMs) return null;

  const chatJid = key.remoteJid;
  const isGroup = isJidGroup(chatJid);
  const senderJid = key.fromMe ? 'me' : key.participant || chatJid;

  return {
    user_email: userEmail,
    card_id: 'whatsapp',
    wa_msg_id: key.id,
    chat_id: chatJid,
    chat_name: names.resolveChatName(chatJid),
    sender: senderJid,
    sender_name: names.resolveSenderName(m, selfName),
    from_me: !!key.fromMe,
    msg_timestamp: new Date(tsMs).toISOString(),
    body: text,
    is_group: isGroup,
  };
}

// Persist a batch, honoring the history floor. Idempotent on
// (user_email, wa_msg_id); on conflict we UPDATE (names improve during a run).
async function persistRows(rows, floorIso) {
  if (rows.length === 0) return 0;
  const filtered = floorIso ? rows.filter((r) => r.msg_timestamp >= floorIso) : rows;
  if (filtered.length === 0) return 0;
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

  // Resilience: if the schema cache doesn't yet know is_group (migration 0008
  // not applied / not reloaded), strip it and retry once rather than zeroing the
  // whole run. is_group backfills later via the migration.
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

export async function captureWhatsapp(acct) {
  const userEmail = acct.user_email;

  const registered = await hasCreds(userEmail);
  if (!registered) {
    console.log(`[${userEmail}/wa] no registered credentials — pair once, skipping capture`);
    return { captured: 0, notPaired: true };
  }

  const isBackfill = !acct.backfill_done;

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

    const oldest = new Map();   // chatJid -> { key, tsMs }
    const rounds = new Map();   // chatJid -> number
    const satisfied = new Set();

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

    async function onQuiet() {
      if (done) return;
      if (!isBackfill) return finish('quiet');
      const requested = await driveBackfill();
      if (requested === 0) return finish('backfill-complete');
      bumpQuiet();
    }

    async function driveBackfill() {
      if (!sock || typeof sock.fetchMessageHistory !== 'function') return 0;
      let requested = 0;
      for (const [chatJid, o] of oldest.entries()) {
        if (satisfied.has(chatJid)) continue;
        if (o.tsMs <= floorMs) { satisfied.add(chatJid); continue; }
        const r = rounds.get(chatJid) || 0;
        if (r >= MAX_HISTORY_ROUNDS) { satisfied.add(chatJid); continue; }
        rounds.set(chatJid, r + 1);
        try {
          await sock.fetchMessageHistory(HISTORY_PAGE, o.key, o.tsMs);
          requested += 1;
        } catch {
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
      // Only mark backfill complete if persist succeeded AND we buffered
      // something — never burn the one-time pass on a failed/empty run.
      const backfilledSomething = persistOk && buffer.length > 0;
      if (isBackfill && backfilledSomething && (reason === 'backfill-complete' || reason === 'quiet')) {
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
      try { await flush(); } catch (e) { console.error(`[${userEmail}/wa] cred flush failed:`, e.message); }
      try { sock?.end(undefined); } catch {}
      const sizes = names._sizes();
      console.log(
        `[${userEmail}/wa] capture done (${reason}) — ${captured} rows, ` +
        `${oldest.size} chats, names[contacts=${sizes.contacts},chats=${sizes.chats}]`
      );
      resolve({ captured });
    };

    hardTimer = setTimeout(() => finish('ceiling'), drainCeiling);

    async function connect() {
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: isBackfill,
        browser: Browsers.ubuntu('Chrome'),
      });

      selfName = sock.authState?.creds?.me?.name || selfName;

      sock.ev.on('creds.update', () => {
        selfName = sock.authState?.creds?.me?.name || selfName;
        return saveCreds();
      });

      sock.ev.on('messaging-history.set', ({ contacts, chats, messages }) => {
        names.ingestContacts(contacts || []);
        names.ingestChats(chats || []);
        collect(messages || []);
      });
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

          if (code === DisconnectReason.restartRequired || code === 515 || code === 428) {
            try { sock?.end(undefined); } catch {}
            if (reconnects >= MAX_RECONNECTS) { finish(`too-many-reconnects-${code}`); return; }
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
