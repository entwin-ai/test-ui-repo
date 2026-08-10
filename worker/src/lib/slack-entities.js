// Slack per-entity metadata collector (Slack Ingestion Read Me §2, §4, §7).
//
// The Slack analogue of wa-entities.js. Slack is pull-based, so rather than
// listening to socket events we build one record per entity from the
// conversation objects `conversations.list` already returns during capture,
// keyed by a STABLE, durable platform ID — never a display name (Read Me §2):
//
//   individual        -> Slack user ID           (the DM's `user` field)
//   group chat (mpim)  -> group DM conversation ID (Read Me §2: the group DM's
//                         own id, not the member set)
//   closed channel     -> channel ID              (private channel)
//   public channel     -> channel ID
//   external (Connect)  -> shape-dependent key      (Read Me §7)
//
// It also reads the two live/structural facts the tier classifier needs:
//   * archived      — the live Ignore-tier state (Read Me §4). Read straight off
//                     the conversation object every run; null when the layer did
//                     not surface it, treated as "not archived" downstream.
//   * external shape — for a Slack Connect conversation, which of the three
//                     shapes applies (Read Me §7), so the identity key follows
//                     the shape rather than a single rule. Determined from the
//                     connection's structure at capture time, NOT inferred from
//                     message content.
//
// At end-of-run capture hands the flat list to upsert into slack_entity.

// Classify a raw Slack conversation object into one of the five entity types.
// External (Slack Connect) is detected first because a shared channel is still
// is_channel/is_private; its Connect-ness (is_ext_shared / is_org_shared) is
// what makes it external, and Read Me §7 keys it by shape, not by public/private.
export function classifyEntityType(conv) {
  if (isExternalConnect(conv)) return 'external';
  if (conv.is_im) return 'individual';
  if (conv.is_mpim) return 'group_chat';
  if (conv.is_private) return 'closed_channel';
  return 'public_channel';
}

// A conversation is a Slack Connect (external) connection when Slack flags it as
// externally or org shared, or when it carries connected-team metadata. We read
// these defensively across the field names Slack uses.
export function isExternalConnect(conv) {
  return (
    conv.is_ext_shared === true ||
    conv.is_org_shared === true ||
    conv.is_shared === true ||
    (Array.isArray(conv.connected_team_ids) && conv.connected_team_ids.length > 0) ||
    (Array.isArray(conv.internal_team_ids) &&
      Array.isArray(conv.shared_team_ids) &&
      conv.shared_team_ids.some((t) => !conv.internal_team_ids.includes(t)))
  );
}

// Read Me §7 — resolve which of the three Slack Connect shapes a conversation is,
// from its structure at capture time (never from message content):
//   * 1:1 external DM               -> 'dm'      (keyed per external user id)
//   * org-wide Slack Connect        -> 'org'     (keyed per external organization)
//   * a single external channel     -> 'channel' (keyed per channel id)
// Returns { shape, key, orgId }.
export function externalShapeAndKey(conv) {
  // A 1:1 external DM is an IM that is externally shared.
  if (conv.is_im) {
    return { shape: 'dm', key: conv.user || conv.id, orgId: null };
  }
  // Org-wide Slack Connect: the whole channel is shared with an external org,
  // and the twin tracks the relationship with the partner ORG as a whole
  // (Read Me §7), so key on the external org id rather than the channel.
  if (conv.is_org_shared === true) {
    const orgId = externalOrgId(conv);
    if (orgId) return { shape: 'org', key: orgId, orgId };
    // Fall through to per-channel if we couldn't read a partner org id.
  }
  // A single external channel (not org-wide) is keyed per channel, using the
  // channel's own id, the same as an internal closed channel (Read Me §7).
  return { shape: 'channel', key: conv.id, orgId: externalOrgId(conv) };
}

// Best-effort external partner organization id, read defensively across the
// shapes Slack exposes it under.
function externalOrgId(conv) {
  if (typeof conv.context_team_id === 'string' && conv.context_team_id) {
    // context_team_id is the HOST team; the partner is whichever shared team id
    // is not one of the internal team ids.
    const shared = Array.isArray(conv.shared_team_ids) ? conv.shared_team_ids : [];
    const internal = Array.isArray(conv.internal_team_ids) ? conv.internal_team_ids : [];
    const partner = shared.find((t) => !internal.includes(t));
    if (partner) return partner;
  }
  if (Array.isArray(conv.connected_team_ids) && conv.connected_team_ids.length > 0) {
    return conv.connected_team_ids[0];
  }
  if (Array.isArray(conv.shared_team_ids) && conv.shared_team_ids.length > 0) {
    return conv.shared_team_ids[0];
  }
  return null;
}

// Human label for a conversation (LABEL only — never the identity key).
export function entityLabel(conv) {
  if (conv.name) return `#${conv.name}`;
  if (conv.is_im) return conv.user ? `DM (${conv.user})` : 'Direct message';
  if (conv.is_mpim) return 'Group DM';
  return conv.id;
}

// Compute the stable identity key + type + label + metadata for a conversation
// object, following Read Me §2 (durable IDs) and §7 (Connect granularity).
// Returns a partial slack_entity record, or null if the object is unusable.
export function entityRecordFor(conv) {
  if (!conv || !conv.id) return null;
  const type = classifyEntityType(conv);

  let identityKey;
  let externalShape = null;
  let externalOrg = null;

  if (type === 'external') {
    const ext = externalShapeAndKey(conv);
    identityKey = ext.key;
    externalShape = ext.shape;
    externalOrg = ext.orgId;
  } else if (type === 'individual') {
    // Read Me §2 — key an individual to their Slack user ID, not the DM's own
    // channel id (which is not portable the way the user id is).
    identityKey = conv.user || conv.id;
  } else {
    // group chat, closed channel, public channel -> keyed to the conversation /
    // channel id (Read Me §2).
    identityKey = conv.id;
  }

  if (!identityKey) return null;

  const archived =
    conv.is_archived !== undefined && conv.is_archived !== null
      ? Boolean(conv.is_archived)
      : null;

  return {
    slack_entity_type: type,
    identity_key: identityKey,
    channel_id: conv.id,
    display_name: entityLabel(conv),
    archived,
    external_shape: externalShape,
    external_org_id: externalOrg,
  };
}

// A per-run in-memory registry: identity_key -> partial slack_entity record.
// Capture feeds it every conversation object it enumerates; at end-of-run it
// hands capture a flat list of rows to upsert.
export function createSlackEntityRegistry() {
  const entities = new Map();

  function ingestConversation(conv) {
    const rec = entityRecordFor(conv);
    if (!rec) return null;
    const cur = entities.get(rec.identity_key) || {};
    // Last-writer-wins for live fields; keep any known non-null structural value.
    for (const [k, v] of Object.entries(rec)) {
      if (v === undefined || v === null) continue;
      cur[k] = v;
    }
    // archived is LIVE — always take the latest read, even when null->false.
    if (rec.archived !== undefined && rec.archived !== null) cur.archived = rec.archived;
    cur.identity_key = rec.identity_key;
    cur.slack_entity_type = cur.slack_entity_type || rec.slack_entity_type;
    entities.set(rec.identity_key, cur);
    return rec;
  }

  function get(identityKey) {
    return entities.get(identityKey) || null;
  }

  function toRows(userEmail, cardId) {
    const out = [];
    for (const rec of entities.values()) {
      if (!rec.identity_key || !rec.slack_entity_type) continue;
      out.push({
        user_email: userEmail,
        card_id: cardId || 'slack-workspace',
        slack_entity_type: rec.slack_entity_type,
        identity_key: rec.identity_key,
        channel_id: rec.channel_id ?? null,
        display_name: rec.display_name ?? null,
        archived: rec.archived ?? null,
        external_shape: rec.external_shape ?? null,
        external_org_id: rec.external_org_id ?? null,
        last_seen_at: new Date().toISOString(),
      });
    }
    return out;
  }

  return { ingestConversation, get, toRows, _size: () => entities.size };
}
