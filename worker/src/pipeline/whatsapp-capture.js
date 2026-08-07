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
import { createEntityRegistry } from '../lib/wa-entities.js';

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

// Build a ledger row, resolving names through the registry. entityReg (when
// provided) supplies the three-way type + community parentage the plain jid
// can't (community vs plain group needs group metadata); we fall back to the
// jid-derived person/group when metadata for this chat hasn't arrived yet.
function toRow(userEmail, m, names, selfName, entityReg) {
  const text = extractText(m);
  if (!text) return null;
  const key = m.key;
  if (!key?.id || !key.remoteJid || isStatus(key.remoteJid)) return null;
  const tsMs = msgTsMs(m);
  if (!tsMs) return null;

  const chatJid = key.remoteJid;
  const isGroup = isJidGroup(chatJid);
  const senderJid = key.fromMe ? 'me' : key.participant || chatJid;

  const meta = entityReg?.lookupByJid ? entityReg.lookupByJid(chatJid) : null;
  const waEntityType = meta?.wa_entity_type || (isGroup ? 'group' : 'person');
  const communityId = meta?.community_id || null;

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
    wa_entity_type: waEntityType,
    community_id: communityId,
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

  // Resilience: if the schema cache doesn't yet know a newly-added column
  // (migration 0008 is_group, or 0016 wa_entity_type/community_id — not applied
  // / not reloaded), strip the offending columns and retry once rather than
  // zeroing the whole run. They backfill later via the migration + reprocess.
  if (error && /is_group|wa_entity_type|community_id/.test(error.message) &&
      /schema cache|column/.test(error.message)) {
    console.warn('whatsapp_message: new column not in schema cache — retrying without 0008/0016 columns');
    const stripped = unique.map(({ is_group, wa_entity_type, community_id, ...rest }) => rest);
    ({ error } = await admin
      .from('whatsapp_message')
      .upsert(stripped, { onConflict: 'user_email,wa_msg_id' }));
  }
  if (error) throw new Error(`whatsapp_message upsert: ${error.message}`);
  return unique.length;
}

// Upsert the per-run entity metadata (Phase 1.2) into whatsapp_entity. Keyed on
// (user_email, identity_key) so it's idempotent: each run refreshes the live
// fields (muted/archived/member_count/is_admin) for every entity it observed.
// Best-effort and isolated from message capture — a metadata upsert failure must
// never fail the run or block message ingestion, so the caller wraps this in its
// own try/catch and continues. Resilient to a stale schema cache the same way
// persistRows() is (migration 0016 not yet reloaded).
async function persistEntities(rows) {
  if (!rows || rows.length === 0) return 0;
  let { error } = await admin
    .from('whatsapp_entity')
    .upsert(rows, { onConflict: 'user_email,identity_key' });
  if (error && /whatsapp_entity|wa_entity_type|identity_key/.test(error.message) &&
      /schema cache|does not exist|column|relation/.test(error.message)) {
    console.warn(`whatsapp_entity not in schema cache yet (migration 0016?) — skipping metadata upsert this run`);
    return 0;
  }
  if (error) throw new Error(`whatsapp_entity upsert: ${error.message}`);
  return rows.length;
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
  const entityReg = createEntityRegistry();
  entityReg.setSelf(state?.creds?.me?.id || null, state?.creds?.me?.lid || null);

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
        const row = toRow(userEmail, m, names, selfName, entityReg);
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

      // Phase 1.2: persist per-entity metadata (whatsapp_entity). Best-effort and
      // fully isolated — a failure here never affects message capture above.
      let entitiesUpserted = 0;
      try {
        entitiesUpserted = await persistEntities(entityReg.toRows(userEmail, acct.card_id));
      } catch (e) {
        console.error(`[${userEmail}/wa] entity metadata upsert failed:`, e.message);
      }

      const sizes = names._sizes();
      console.log(
        `[${userEmail}/wa] capture done (${reason}) — ${captured} rows, ` +
        `${oldest.size} chats, ${entitiesUpserted} entities, ` +
        `names[contacts=${sizes.contacts},chats=${sizes.chats}]`
      );
      resolve({ captured, entities: entitiesUpserted });
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
        for (const c of contacts || []) entityReg.ingestContact(c);
        for (const ch of chats || []) entityReg.ingestChat(ch);
        collect(messages || []);
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        names.ingestContacts(contacts || []);
        for (const c of contacts || []) entityReg.ingestContact(c);
      });
      sock.ev.on('contacts.update', (contacts) => {
        names.ingestContacts(contacts || []);
        for (const c of contacts || []) entityReg.ingestContact(c);
      });
      sock.ev.on('chats.upsert', (chats) => {
        names.ingestChats(chats || []);
        for (const ch of chats || []) entityReg.ingestChat(ch);
      });
      // chats.update carries the LIVE archived/muted flips (Read Me §4) — feed
      // them so this run's whatsapp_entity row reflects current state.
      sock.ev.on('chats.update', (updates) => {
        for (const u of updates || []) entityReg.ingestChatUpdate(u);
      });
      sock.ev.on('groups.upsert', (groups) => {
        for (const g of groups || []) {
          names.ingestGroupMetadata(g);
          entityReg.ingestGroupMetadata(g);
        }
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
