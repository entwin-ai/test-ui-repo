import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { admin } from '../lib/supabase.js';
import { useRedisAuthState, hasCreds } from '../lib/wa-auth-store.js';

// ============================================================================
// WhatsApp ingestion-layer CAPABILITY PROBE (Phase 0).
//
// This is a VERIFICATION spike, not an ingestion path. It opens a short-lived,
// read-only socket and inspects ONLY the metadata surface Baileys exposes — it
// deliberately does NOT read, store, or vectorize any message body. Its whole
// job is to answer, against the real ingestion layer, the three questions that
// gate the WhatsApp build:
//
//   0.1  Are per-chat metadata fields readable at capture time?
//        (group vs 1:1 vs community, muted, member_count, self-admin, archived,
//        community parentage, community-admin) — gates Phase 1 + Phase 2.
//   0.2  Does the WhatsApp username come with a STABLE, account-tied identifier,
//        or only editable display text? — gates Phase 1.3 + Phase 6 auto-merge.
//   0.3  Is archived state re-readable each run, and is unarchiving detectable?
//        — gates the live Ignore override in Phase 2.
//
// It writes a machine-readable row to whatsapp_capability_probe and prints a
// human-readable summary. Nothing downstream depends on it; it is safe to run
// against a linked account at any time.
//
// It NEVER marks anything as ingested, never touches sync_state, never writes a
// memory_note. Read-only by construction.
// ============================================================================

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

const PROBE_MS = Number(process.env.WA_PROBE_MS || 45_000);   // socket lifetime ceiling
const QUIET_MS = Number(process.env.WA_PROBE_QUIET_MS || 8_000);

// Candidate paths where a durable username identifier might live on a contact
// object. The probe records which (if any) is populated AND whether it looks
// like a stable id vs. free display text. WhatsApp's username feature is newer
// than much of Baileys' typing, so we look broadly rather than assuming a path.
const USERNAME_CANDIDATE_PATHS = [
  'username',
  'lid',           // linked-id: account-tied, survives number change — the ideal signal
  'verifiedName',
  'notify',
  'name',
];

// A value that looks like a durable, account-tied identifier (an id/handle),
// vs. one that looks like a human display string. Heuristic, reported as such.
function looksDurable(value) {
  if (typeof value !== 'string' || !value) return false;
  // lids look like "12036...@lid" or a long opaque token; display names have spaces.
  if (/@lid$/.test(value)) return true;
  if (/\s/.test(value)) return false;             // has whitespace -> display text
  if (/^[a-z0-9._-]{3,}$/i.test(value)) return true; // handle-like
  return false;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export async function probeWhatsapp(acct) {
  const userEmail = acct.user_email;

  const registered = await hasCreds(userEmail);
  if (!registered) {
    console.log(`[${userEmail}/wa-probe] no registered credentials — pair once, skipping probe`);
    return { notPaired: true };
  }

  const { state, saveCreds, flush } = await useRedisAuthState(userEmail);
  const startedAt = Date.now();

  // Accumulators. We record COVERAGE (present on how many eligible objects), not
  // just a single boolean, because "the field exists on the type but is absent
  // on most chats" is a finding Phase 2 must design around.
  const cov = {
    group_type: { eligible: 0, present: 0 },
    community_type: { eligible: 0, present: 0 },
    muted: { eligible: 0, present: 0 },
    member_count: { eligible: 0, present: 0 },
    self_admin: { eligible: 0, present: 0 },
    archived: { eligible: 0, present: 0 },
    community_parent: { eligible: 0, present: 0 },
    community_admin: { eligible: 0, present: 0 },
  };

  const usernameHits = []; // { path, value, durable }
  const seen = { chats: 0, groups: 0, communities: 0, contacts: 0 };
  const archivedStates = new Map(); // chatJid -> archived boolean, to spot changes within the run
  let unarchiveObserved = false;
  const warnings = [];

  const bump = (k, present) => { cov[k].eligible += 1; if (present) cov[k].present += 1; };

  // --- inspect a chat object (from messaging-history.set `chats` or chats.upsert)
  function inspectChat(ch) {
    if (!ch?.id) return;
    seen.chats += 1;
    const isGroup = isJidGroup(ch.id);

    // 0.1 group vs 1:1 — derivable from the jid, always. Record it as available.
    bump('group_type', true);

    // 0.3 archived — Baileys surfaces it as `archived` (boolean) or via
    // archive flag on the chat. Presence of the KEY is what we're testing.
    const hasArchived = ch.archived !== undefined && ch.archived !== null;
    bump('archived', hasArchived);
    if (hasArchived) {
      const prev = archivedStates.get(ch.id);
      if (prev !== undefined && prev === true && ch.archived === false) unarchiveObserved = true;
      archivedStates.set(ch.id, !!ch.archived);
    }

    // muted — `muteEndTime` / `mute` on the chat object.
    const hasMute = ch.muteEndTime !== undefined || ch.mute !== undefined;
    bump('muted', hasMute);

    if (isGroup) {
      seen.groups += 1;
      // community parentage — Baileys exposes linked-parent via
      // `linkedParent` / `parentGroup` on group-ish chats when it's a subgroup.
      const parent = ch.linkedParent || ch.parentGroupId || ch.parentJid;
      bump('community_parent', parent !== undefined && parent !== null);
    }
  }

  // --- inspect group metadata (groups.upsert / groupMetadata) — richest source
  function inspectGroupMeta(meta) {
    if (!meta?.id) return;
    seen.groups += 1;

    // member_count — participants array length.
    const hasMembers = Array.isArray(meta.participants);
    bump('member_count', hasMembers);

    // self-admin — find our own participant entry and read admin flag.
    const selfLid = state?.creds?.me?.lid || null;
    const selfJid = state?.creds?.me?.id || null;
    if (hasMembers) {
      const mine = meta.participants.find(
        (p) => p.id === selfJid || (selfLid && p.id === selfLid) || p.isSelf,
      );
      // admin is 'admin' | 'superadmin' | null on the participant.
      bump('self_admin', mine ? mine.admin !== undefined : false);
    } else {
      bump('self_admin', false);
    }

    // community detection — a community parent announces itself via
    // `isCommunity` / `communityId`, and a subgroup via `linkedParent`.
    const isCommunity = meta.isCommunity === true || meta.communityId !== undefined;
    const isSubgroup = meta.linkedParent !== undefined || meta.parentJid !== undefined;
    if (isCommunity || isSubgroup) {
      seen.communities += 1;
      bump('community_type', true);
      // community-admin: if we can see our admin role on the parent announce group.
      bump('community_admin', isCommunity ? (Array.isArray(meta.participants)) : false);
    } else {
      bump('community_type', false);
    }
  }

  // --- inspect a contact (contacts.upsert / history `contacts`) for 0.2
  function inspectContact(c) {
    if (!c?.id) return;
    seen.contacts += 1;
    for (const path of USERNAME_CANDIDATE_PATHS) {
      const value = getPath(c, path);
      if (value !== undefined && value !== null && value !== '') {
        // We only care about paths that could serve as a stable alias key.
        // Record every populated candidate with a durability verdict.
        if (path === 'username' || path === 'lid') {
          usernameHits.push({ path, value: String(value), durable: looksDurable(String(value)) });
        }
      }
    }
  }

  return await new Promise((resolve) => {
    let done = false;
    let quietTimer = null;
    let hardTimer = null;
    let reconnects = 0;
    const MAX_RECONNECTS = 4;
    let sock = null;

    function bumpQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), QUIET_MS);
    }

    const finish = async (reason) => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);

      // ---- Derive the verdicts from coverage --------------------------------
      const pct = (k) => (cov[k].eligible ? Math.round((cov[k].present / cov[k].eligible) * 100) : 0);
      const avail = (k) => cov[k].present > 0;

      const coverage = {};
      for (const k of Object.keys(cov)) {
        coverage[k] = { eligible: cov[k].eligible, present: cov[k].present, pct: pct(k) };
      }

      // 0.2 username durability verdict.
      let usernameDurability = 'absent';
      let usernameFieldPath = null;
      const durableHit = usernameHits.find((h) => h.durable);
      const anyHit = usernameHits[0];
      if (durableHit) {
        usernameDurability = 'durable';
        usernameFieldPath = durableHit.path;
      } else if (anyHit) {
        usernameDurability = 'text_only';
        usernameFieldPath = anyHit.path;
      } else if (seen.contacts === 0) {
        usernameDurability = 'unknown';
      } else {
        usernameDurability = 'absent';
      }

      // 0.3 archived liveness.
      const archivedLiveReadable = avail('archived');
      // Within a single probe window we usually won't SEE a toggle, so
      // "detectable in principle" = the key is readable. A true observed flip is
      // a stronger positive when it happens.
      const unarchiveDetectable = archivedLiveReadable || unarchiveObserved;

      const record = {
        user_email: userEmail,
        card_id: acct.card_id || 'whatsapp',
        socket_ms: Date.now() - startedAt,

        group_type_available: avail('group_type'),
        community_type_available: avail('community_type'),
        muted_available: avail('muted'),
        member_count_available: avail('member_count'),
        self_admin_available: avail('self_admin'),
        archived_available: avail('archived'),
        community_parent_available: avail('community_parent'),
        community_admin_available: avail('community_admin'),
        metadata_coverage: coverage,

        username_durability: usernameDurability,
        username_field_path: usernameFieldPath,
        username_sample_count: usernameHits.length,

        archived_live_readable: archivedLiveReadable,
        unarchive_detectable: unarchiveDetectable,

        chats_seen: seen.chats,
        groups_seen: seen.groups,
        communities_seen: seen.communities,
        contacts_seen: seen.contacts,

        notes: buildNotes({ reason, coverage, usernameDurability, seen, warnings, unarchiveObserved }),
        raw: {
          reason,
          coverage,
          username_hits: usernameHits.slice(0, 20),
          warnings,
          unarchive_observed: unarchiveObserved,
        },
      };

      try {
        const { error } = await admin.from('whatsapp_capability_probe').insert(record);
        if (error) console.error(`[${userEmail}/wa-probe] insert failed:`, error.message);
      } catch (e) {
        console.error(`[${userEmail}/wa-probe] insert threw:`, e.message);
      }

      printSummary(userEmail, record);

      try { await flush(); } catch {}
      try { sock?.end(undefined); } catch {}
      resolve({ ok: true, record });
    };

    hardTimer = setTimeout(() => finish('ceiling'), PROBE_MS);

    async function connect() {
      const { version } = await fetchLatestBaileysVersion();
      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,          // probe: metadata only, no history walk
        browser: Browsers.ubuntu('Chrome'),
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
        for (const c of contacts || []) inspectContact(c);
        for (const ch of chats || []) inspectChat(ch);
        bumpQuiet();
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts || []) inspectContact(c);
        bumpQuiet();
      });
      sock.ev.on('chats.upsert', (chats) => {
        for (const ch of chats || []) inspectChat(ch);
        bumpQuiet();
      });
      sock.ev.on('chats.update', (updates) => {
        // 0.3: a chats.update carrying `archived` is a LIVE state change — the
        // exact signal the Ignore override relies on. Flag if we see a flip.
        for (const u of updates || []) {
          if (u.archived !== undefined) {
            const prev = archivedStates.get(u.id);
            if (prev === true && u.archived === false) unarchiveObserved = true;
            archivedStates.set(u.id, !!u.archived);
          }
        }
        bumpQuiet();
      });
      sock.ev.on('groups.upsert', (groups) => {
        for (const g of groups || []) inspectGroupMeta(g);
        bumpQuiet();
      });

      sock.ev.on('connection.update', (u) => {
        if (done) return;
        const { connection, lastDisconnect } = u;
        if (connection === 'open') { bumpQuiet(); return; }
        if (connection === 'close') {
          const code = lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : undefined;
          if (code === DisconnectReason.loggedOut) { finish('logged-out'); return; }
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

function buildNotes({ reason, coverage, usernameDurability, seen, warnings, unarchiveObserved }) {
  const lines = [];
  lines.push(`probe finished: ${reason}`);
  lines.push(
    `seen: ${seen.chats} chats, ${seen.groups} groups, ${seen.communities} communities, ${seen.contacts} contacts`,
  );
  if (seen.groups === 0) {
    warnings.push('No groups observed in the probe window — group/community/admin/member-count findings are UNCONFIRMED. Re-run against an account that is in at least one group and one community.');
  }
  if (seen.communities === 0) {
    warnings.push('No communities observed — community_type / community_admin / community_parent findings are UNCONFIRMED. Join or probe against a community before trusting the cascade rule (Read Me §5).');
  }
  if (usernameDurability === 'unknown') {
    warnings.push('Username durability UNKNOWN — no contact in-sample had a username set. Phase 6.2.1 (username auto-merge) cannot be greenlit until a durable identifier is confirmed on a real account.');
  }
  if (usernameDurability === 'text_only') {
    warnings.push('Username surfaced as display TEXT ONLY (no stable backing id) — Phase 6.2.1 auto-merge must DEGRADE to a fuzzy signal, per the Read Me caveat.');
  }
  if (unarchiveObserved) lines.push('observed a live archived->unarchived flip during the probe (0.3 strong positive).');
  return [...lines, ...warnings.map((w) => `WARN: ${w}`)].join('\n');
}

function printSummary(userEmail, r) {
  const yn = (b) => (b === true ? 'YES' : b === false ? 'no' : '?');
  console.log(`\n===== WhatsApp capability probe — ${userEmail} =====`);
  console.log(`socket open: ${r.socket_ms}ms | seen: ${r.chats_seen} chats / ${r.groups_seen} groups / ${r.communities_seen} communities / ${r.contacts_seen} contacts`);
  console.log(`\n[0.1] per-chat metadata`);
  console.log(`  group vs 1:1 .......... ${yn(r.group_type_available)}  (${r.metadata_coverage.group_type.pct}%)`);
  console.log(`  community/subgroup .... ${yn(r.community_type_available)}  (${r.metadata_coverage.community_type.pct}%)`);
  console.log(`  muted ................. ${yn(r.muted_available)}  (${r.metadata_coverage.muted.pct}%)`);
  console.log(`  member_count .......... ${yn(r.member_count_available)}  (${r.metadata_coverage.member_count.pct}%)`);
  console.log(`  self admin state ...... ${yn(r.self_admin_available)}  (${r.metadata_coverage.self_admin.pct}%)`);
  console.log(`  archived .............. ${yn(r.archived_available)}  (${r.metadata_coverage.archived.pct}%)`);
  console.log(`  community parentage ... ${yn(r.community_parent_available)}  (${r.metadata_coverage.community_parent.pct}%)`);
  console.log(`  community admin ....... ${yn(r.community_admin_available)}  (${r.metadata_coverage.community_admin.pct}%)`);
  console.log(`\n[0.2] username durability: ${String(r.username_durability).toUpperCase()}` +
    (r.username_field_path ? ` (field: ${r.username_field_path}, samples: ${r.username_sample_count})` : ''));
  console.log(`[0.3] archived live readable: ${yn(r.archived_live_readable)} | unarchive detectable: ${yn(r.unarchive_detectable)}`);
  if (r.notes) console.log(`\n${r.notes}`);
  console.log(`\n(result persisted to whatsapp_capability_probe)\n`);
}
