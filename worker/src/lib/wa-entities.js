// WhatsApp per-entity metadata collector (Phase 1.2).
//
// A per-run, in-memory registry — the metadata sibling of wa-names.js. Where the
// name registry harvests a stable DISPLAY NAME for each chat/sender, this one
// harvests the STRUCTURAL + LIVE metadata the Phase 2 tier classifier reads:
// entity type (person | group | community), muted, member_count, self-admin,
// archived, and community parentage + the parent community's admin state.
//
// It listens to the same Baileys events capture already wires (messaging-history
// `chats`, chats.upsert/update, groups.upsert), accumulates one record per
// entity keyed by a STABLE identity key (phone / group id / community id — never
// display name, per Read Me §2), and at end-of-run hands capture a flat list to
// upsert into whatsapp_entity.
//
// IMPORTANT — availability is not assumed. The exact Baileys field paths for
// self-admin, community parentage, and community-admin are library-version
// dependent (WhatsApp communities are newer than much of Baileys' typing). This
// collector reads them defensively and leaves a field NULL when the layer did
// not surface it, so Phase 2 can apply the Phase 0 decision-record fallback
// (null admin -> treat as non-admin, etc.) rather than acting on a wrong guess.
// The Phase 0 probe (whatsapp-probe.js) is what confirms which of these are
// actually populated on a real account before Phase 2 builds against them.

import { isJidGroup } from '@whiskeysockets/baileys';

function jidToPhone(jid) {
  if (!jid) return null;
  const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
  if (!/^\d{6,15}$/.test(user)) return null;
  return `+${user}`;
}

// Identity key (Read Me §2): phone for a person, the jid for a group/community.
function identityKeyFor(chatJid, type) {
  if (!chatJid) return null;
  if (type === 'person') return jidToPhone(chatJid) || chatJid;
  return chatJid; // group / community keyed by their id (the jid)
}

// Read the user's own admin state out of a group-metadata participants array.
// Returns true | false | null (null = couldn't determine, NOT "not admin").
function selfAdminFrom(meta, selfJid, selfLid) {
  if (!Array.isArray(meta?.participants)) return null;
  const mine = meta.participants.find(
    (p) => p.id === selfJid || (selfLid && p.id === selfLid) || p.isSelf,
  );
  if (!mine) return null;
  if (mine.admin === undefined) return null;
  return mine.admin === 'admin' || mine.admin === 'superadmin';
}

// Detect community shape from group metadata, defensively across field names.
function communityShape(meta) {
  const isCommunity = meta?.isCommunity === true || meta?.communityId !== undefined;
  const parent =
    meta?.linkedParent ?? meta?.parentJid ?? meta?.parentGroupId ?? meta?.communityId ?? null;
  return { isCommunity, parent: parent || null };
}

// Candidate paths a durable, account-tied username identifier might live on
// (matches whatsapp-probe.js). 'lid' is the strongest — it travels with the
// account, not the number (Read Me §2 / appendix). A value looks DURABLE if it
// is an lid or a handle-like token with no whitespace; a display string with
// spaces is text-only and must not be trusted as a match key.
const USERNAME_PATHS = ['username', 'lid'];
function looksDurableUsername(value) {
  if (typeof value !== 'string' || !value) return false;
  if (/@lid$/.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /^[a-z0-9._-]{3,}$/i.test(value);
}

export function createEntityRegistry() {
  // identity_key -> partial whatsapp_entity record (merged as events arrive).
  const entities = new Map();
  let selfJid = null;
  let selfLid = null;

  function setSelf(jid, lid) {
    if (jid) selfJid = jid;
    if (lid) selfLid = lid;
  }

  // Merge a partial into the record for identity_key, keeping the most
  // informative value: live fields (muted/archived) take the LATEST non-null,
  // structural fields (type/member_count) take any known value.
  // Display-name source strength: a saved contact name beats a business
  // verifiedName beats a pushName. Higher wins; a stronger name already recorded
  // is never overwritten by a weaker one regardless of event arrival order.
  const NAME_RANK = { contact: 3, verified: 2, push: 1 };

  function merge(identityKey, patch) {
    if (!identityKey) return;
    const cur = entities.get(identityKey) || { identity_key: identityKey };
    const nameRank = patch.__name_rank;
    delete patch.__name_rank;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) continue;
      if (k === 'display_name') {
        const incoming = nameRank || NAME_RANK.contact; // default: treat as strong
        const held = cur.__name_rank || 0;
        if (incoming < held) continue; // keep the stronger name we already have
        cur.display_name = v;
        cur.__name_rank = incoming;
        continue;
      }
      cur[k] = v; // last-writer-wins; events arrive newest-last within a run
    }
    entities.set(identityKey, cur);
  }

  // --- chat objects (messaging-history `chats`, chats.upsert) ----------------
  // Source of: type (group vs person), muted, archived, and — for a subgroup —
  // community parentage when the chat object carries it.
  function ingestChat(ch) {
    if (!ch?.id) return;
    const jid = ch.id;
    const isGroup = isJidGroup(jid);
    const type = isGroup ? 'group' : 'person';
    const key = identityKeyFor(jid, type);

    const muted =
      ch.muteEndTime !== undefined
        ? Number(ch.muteEndTime) > Math.floor(Date.now() / 1000)
        : ch.mute !== undefined
        ? Boolean(ch.mute)
        : null;

    const archived = ch.archived !== undefined && ch.archived !== null ? Boolean(ch.archived) : null;
    const communityId = ch.linkedParent ?? ch.parentGroupId ?? ch.parentJid ?? null;

    merge(key, {
      wa_entity_type: type,
      chat_jid: jid,
      display_name: cleaner(ch.name),
      muted,
      archived,
      community_id: communityId,
    });
  }

  // --- chats.update — LIVE state deltas (the archived/muted flip signal) ------
  function ingestChatUpdate(u) {
    if (!u?.id) return;
    const jid = u.id;
    const type = isJidGroup(jid) ? 'group' : 'person';
    const key = identityKeyFor(jid, type);
    const patch = { chat_jid: jid, wa_entity_type: type };
    if (u.archived !== undefined) patch.archived = Boolean(u.archived);
    if (u.muteEndTime !== undefined)
      patch.muted = Number(u.muteEndTime) > Math.floor(Date.now() / 1000);
    if (u.name !== undefined) patch.display_name = cleaner(u.name);
    merge(key, patch);
  }

  // --- group metadata (groups.upsert) — richest source -----------------------
  // Source of: member_count, self-admin, community-vs-group, community parentage,
  // and (for a community parent) community-admin.
  function ingestGroupMetadata(meta) {
    if (!meta?.id) return;
    const jid = meta.id;
    const { isCommunity, parent } = communityShape(meta);
    const type = isCommunity ? 'community' : 'group';
    const key = identityKeyFor(jid, type);

    const memberCount = Array.isArray(meta.participants) ? meta.participants.length : null;
    const isAdmin = selfAdminFrom(meta, selfJid, selfLid);

    merge(key, {
      wa_entity_type: type,
      chat_jid: jid,
      display_name: cleaner(meta.subject),
      member_count: memberCount,
      is_admin: isAdmin,
      // A subgroup carries its parent community id; a community parent does not.
      community_id: parent,
      // For a community parent, the user's admin role on it IS is_admin above;
      // we mirror it into community_is_admin so a subgroup lookup can inherit it
      // in Phase 2 (the cascade in Read Me §5). For a plain subgroup we leave it
      // null and let Phase 2 resolve it from the parent's row.
      community_is_admin: isCommunity ? isAdmin : null,
    });
  }

  function cleaner(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t.length) return null;
    // A bare phone number OR WhatsApp's privacy-masked number (e.g.
    // "+1∙∙∙∙∙∙∙∙64", "+44 •••• 22", "+1…07") is not a display name — never
    // store it as one. Mask glyphs: U+2219, U+2022, U+00B7, U+2026, ASCII dot.
    if (/\d/.test(t) && /^\+?[\d\s()\-\u2219\u2022\u00b7\u2026.]{4,}$/.test(t)) return null;
    return t;
  }

  // --- contacts (contacts.upsert / history `contacts`) — username harvest -----
  // Read Me §2 / Phase 1.3: capture a contact's username as a SECONDARY alias on
  // the person entity, never as the identity key (which stays the phone number).
  // We only stash it here; promotion into entity.aliases is the resolver's job
  // (Phase 6), gated on the durability verdict.
  function ingestContact(c) {
    if (!c?.id) return;
    const jid = c.id;
    if (isJidGroup(jid)) return;              // usernames are a person concept here
    const key = identityKeyFor(jid, 'person');
    if (!key) return;

    let username = null;
    let durable = null;
    for (const p of USERNAME_PATHS) {
      const v = c[p];
      if (v !== undefined && v !== null && v !== '') {
        username = String(v);
        durable = looksDurableUsername(username);
        break;
      }
    }

    // Persist the display name WhatsApp shows for this contact — the saved name
    // if we have it, else the verifiedName (business), else notify (pushName).
    // This runs even with NO username: an unsaved contact still has a name the
    // user can see, and dropping it is exactly what left bare phone numbers in
    // the memory notes. cleaner() rejects a bare-number "name" so we never store
    // the phone as the display_name.
    const savedName = cleaner(c.name);
    const verifiedName = cleaner(c.verifiedName);
    const pushName = cleaner(c.notify);
    const displayName = savedName || verifiedName || pushName;
    const nameRank = savedName ? 3 : verifiedName ? 2 : 1;
    if (!username && !displayName) return; // nothing new to record

    merge(key, {
      wa_entity_type: 'person',
      chat_jid: jid,
      display_name: displayName,
      __name_rank: displayName ? nameRank : undefined,
      wa_username: username,
      username_is_durable: username ? durable : null,
    });
  }

  // Record a pushName harvested off a message as the person's display name when
  // no better contact/verified name has arrived. pushName is precisely the label
  // WhatsApp renders for an unsaved incoming contact, so it's the right fallback
  // to persist. cleaner() drops a numeric pushName.
  function ingestPushName(jid, pushName) {
    if (!jid || isJidGroup(jid)) return;
    const key = identityKeyFor(jid, 'person');
    if (!key) return;
    const name = cleaner(pushName);
    if (!name) return;
    merge(key, { wa_entity_type: 'person', chat_jid: jid, display_name: name, __name_rank: 1 });
  }

  // Flat list for capture to upsert. Fills identity defaults and drops anything
  // without a resolvable type/key.
  function toRows(userEmail, cardId) {
    const out = [];
    for (const rec of entities.values()) {
      if (!rec.identity_key || !rec.wa_entity_type) continue;
      out.push({
        user_email: userEmail,
        card_id: cardId || 'whatsapp',
        wa_entity_type: rec.wa_entity_type,
        identity_key: rec.identity_key,
        chat_jid: rec.chat_jid ?? null,
        display_name: rec.display_name ?? null,
        muted: rec.muted ?? null,
        member_count: rec.member_count ?? null,
        is_admin: rec.is_admin ?? null,
        archived: rec.archived ?? null,
        community_id: rec.community_id ?? null,
        community_is_admin: rec.community_is_admin ?? null,
        wa_username: rec.wa_username ?? null,
        username_is_durable: rec.username_is_durable ?? null,
        last_seen_at: new Date().toISOString(),
      });
    }
    return out;
  }

  // Look up a partially-known record by its raw chat jid, for stamping message
  // rows with the resolved type/community as metadata arrives. Returns null if
  // nothing is known for that jid yet (message capture then falls back to the
  // jid-derived person/group).
  function lookupByJid(chatJid) {
    if (!chatJid) return null;
    const type = isJidGroup(chatJid) ? 'group' : 'person';
    const key = identityKeyFor(chatJid, type);
    return entities.get(key) || null;
  }

  return {
    setSelf,
    ingestChat,
    ingestChatUpdate,
    ingestGroupMetadata,
    ingestContact,
    ingestPushName,
    lookupByJid,
    toRows,
    _size: () => entities.size,
  };
}
