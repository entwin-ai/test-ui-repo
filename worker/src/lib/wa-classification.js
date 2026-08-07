import { admin } from './supabase.js';

// WhatsApp tier classification (WhatsApp Ingestion Read Me §3-7).
//
// Every WhatsApp entity-day lands in exactly one of three outcomes:
//   Ignore    -> produce NOTHING (no note, no gist, no rollup)   [Read Me §4]
//   Updates   -> one gist line per entity-day                    [Read Me §3,5]
//   Important -> a full facet-split Memory Note per facet         [Read Me §3]
//
// Ignore is not a stored tier — it IS the archived state, read LIVE off
// whatsapp_entity every run and treated as an ABSOLUTE override. The two STORED
// tiers (updates | important) mirror the two Kanban columns. The effective tier
// for a run is therefore:
//
//   manual override (if the user set one on the Kanban)  -- wins, unless archived
//   else the deterministic rule cascade below            [Read Me §4-5]
//
// evaluated in STRICT ORDER (Read Me §5 "Archived excluded first"):
//   1. archived            -> IGNORE           (absolute; beats admin + manual)
//   2. manual override     -> that tier        (user intent beats the default rules)
//   3. admin exception     -> IMPORTANT        (overrides mute + size; Read Me §5)
//   4. updates triggers    -> UPDATES          (muted | >10 members | community-not-admin)
//   5. default             -> IMPORTANT         (1:1, or a group none of the above hit)
//
// "null = unknown" (Phase 1 contract): a live metadata field the ingestion layer
// didn't surface is null, NOT false. Per the Phase 0 decision record, an unknown
// admin state is treated as NON-admin (the admin exception simply doesn't fire),
// and unknown mute/archived are treated as not-muted / not-archived rather than
// guessed true. This keeps an unreadable field from silently promoting or hiding
// an entity.

export const UPDATES_MEMBER_THRESHOLD = 10; // Read Me §5: "more than 10 members"

// Tier -> what the ingest pipeline does with the entity-day. Ignore is returned
// as its own outcome so the caller writes nothing at all.
export const TIER_IGNORE = 'ignore';
export const TIER_UPDATES = 'updates';
export const TIER_IMPORTANT = 'important';

// ---------------------------------------------------------------------------
// The deterministic cascade over a single whatsapp_entity row. Pure function of
// the entity's live metadata plus (for a subgroup) its parent community's row,
// which the caller resolves and passes in. Returns { tier, reason }.
// ---------------------------------------------------------------------------
export function computeTier(entity, parentCommunity) {
  if (!entity) return { tier: TIER_IMPORTANT, reason: 'no-metadata-default' };

  const type = entity.wa_entity_type; // 'person' | 'group' | 'community'

  // 1. ARCHIVED -> IGNORE. Absolute, first, every entity type incl. 1:1
  //    (Read Me §4). null archived = unknown = treat as not archived.
  if (entity.archived === true) {
    return { tier: TIER_IGNORE, reason: 'archived' };
  }

  // A 1:1 contact is Important by default and NEVER qualifies for Updates
  // automatically (Read Me §5, §7). Only archived (handled above) or a manual
  // move can take a person out of Important — and manual is applied by the
  // caller, not here.
  if (type === 'person') {
    return { tier: TIER_IMPORTANT, reason: 'one-to-one-default' };
  }

  // From here: groups and communities only.

  // 3. ADMIN EXCEPTION -> IMPORTANT, overrides mute + size (Read Me §5).
  //    For a plain subgroup, admin status cascades from the PARENT community:
  //    if the user administers the community, they administer its subgroups.
  const selfAdmin = resolveAdmin(entity, parentCommunity);
  if (selfAdmin === true) {
    return { tier: TIER_IMPORTANT, reason: 'admin-exception' };
  }

  // 4. UPDATES TRIGGERS (any one is sufficient; Read Me §5).
  //    Evaluated only for non-admin groups/communities.

  //  (a) muted. null = unknown = not muted.
  if (entity.muted === true) {
    return { tier: TIER_UPDATES, reason: 'muted' };
  }

  //  (b) more than 10 members. null member_count = unknown -> does NOT trip this
  //      rule (we don't guess a large group from missing data).
  if (typeof entity.member_count === 'number' && entity.member_count > UPDATES_MEMBER_THRESHOLD) {
    return { tier: TIER_UPDATES, reason: 'members>10' };
  }

  //  (c) sits under a community where the user is NOT admin. Cascades to every
  //      subgroup of that community regardless of the subgroup's own size/mute
  //      (Read Me §5). Applies when we KNOW there is a parent community AND we
  //      know the user is not its admin. Unknown community-admin = don't trip.
  if (entity.community_id) {
    const communityAdmin = resolveCommunityAdmin(entity, parentCommunity);
    if (communityAdmin === false) {
      return { tier: TIER_UPDATES, reason: 'community-not-admin' };
    }
  }

  // 5. DEFAULT -> IMPORTANT. A group the user is in that isn't muted, isn't
  //    large, isn't under a non-admin community, and whose admin state is
  //    unknown/false. (A small group you're an ordinary member of is still
  //    worth full notes.)
  return { tier: TIER_IMPORTANT, reason: 'group-default' };
}

// Resolve the user's admin state for this entity, cascading a subgroup to its
// parent community. Returns true | false | null (null = unknown).
function resolveAdmin(entity, parentCommunity) {
  if (entity.is_admin === true) return true;
  // A subgroup inherits admin from the community it belongs to.
  if (entity.community_id && parentCommunity) {
    if (parentCommunity.is_admin === true) return true;
  }
  // Distinguish "known non-admin" from "unknown".
  if (entity.is_admin === false) return false;
  if (entity.community_id && parentCommunity && parentCommunity.is_admin === false) return false;
  return null;
}

// Resolve whether the user is admin of this subgroup's PARENT community.
// Prefers the entity's own community_is_admin snapshot, then the parent row.
function resolveCommunityAdmin(entity, parentCommunity) {
  if (entity.community_is_admin === true) return true;
  if (entity.community_is_admin === false) return false;
  if (parentCommunity) {
    if (parentCommunity.is_admin === true) return true;
    if (parentCommunity.is_admin === false) return false;
  }
  return null; // unknown
}

// ---------------------------------------------------------------------------
// Load the whatsapp_entity row for an identity key, plus its parent community
// row when it's a subgroup (needed for the admin cascade). Batched-friendly but
// simple here; callers that classify many entities should prefer classifyMany.
// ---------------------------------------------------------------------------
async function loadEntity(userEmail, identityKey) {
  const { data } = await admin
    .from('whatsapp_entity')
    .select('*')
    .eq('user_email', userEmail)
    .eq('identity_key', identityKey)
    .maybeSingle();
  return data || null;
}

async function loadParentCommunity(userEmail, communityId) {
  if (!communityId) return null;
  const { data } = await admin
    .from('whatsapp_entity')
    .select('identity_key, wa_entity_type, is_admin, archived')
    .eq('user_email', userEmail)
    .eq('identity_key', communityId)
    .maybeSingle();
  return data || null;
}

async function loadOverride(userEmail, identityKey) {
  const { data } = await admin
    .from('whatsapp_classification')
    .select('tier, confirmed, source')
    .eq('user_email', userEmail)
    .eq('identity_key', identityKey)
    .maybeSingle();
  return data || null;
}

// Persist a bootstrap placement so the Kanban can show the entity. Never
// overwrites a manual row (that's the user's decision); only fills a missing row
// or refreshes a prior bootstrap row's computed tier. Best-effort.
async function recordBootstrap(userEmail, cardId, identityKey, tier, reason, confirmed) {
  // Ignore is not a stored tier — archived entities are never written here.
  if (tier === TIER_IGNORE) return;
  try {
    const existing = await loadOverride(userEmail, identityKey);
    if (existing && existing.source === 'manual') return; // never clobber user intent
    await admin.from('whatsapp_classification').upsert(
      {
        user_email: userEmail,
        card_id: cardId || 'whatsapp',
        identity_key: identityKey,
        tier,
        confirmed,
        source: 'bootstrap',
        bootstrap_reason: reason,
      },
      { onConflict: 'user_email,identity_key' },
    );
  } catch (err) {
    // Table not migrated yet, or transient — never fail classification on it.
    if (!/whatsapp_classification/.test(String(err.message))) {
      console.error(`[${userEmail}] recordBootstrap:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN ENTRY (Phase 2.4 thin wrapper): classify one WhatsApp entity for a run.
//
// Resolves the effective tier as: archived -> IGNORE (absolute) ; else a manual
// Kanban override if present ; else the deterministic cascade. Records a
// bootstrap placement for a not-yet-seen entity so it appears on the Kanban.
//
// Returns { tier, reason, source } where tier is one of
// 'ignore' | 'updates' | 'important'. 'ignore' means the caller writes NOTHING.
// ---------------------------------------------------------------------------
export async function classifyWhatsappEntity(userEmail, identityKey, opts = {}) {
  const cardId = opts.cardId || 'whatsapp';

  // Allow the caller to pass a preloaded entity row (from the run's capture) to
  // avoid a round-trip; otherwise load it.
  const entity = opts.entity || (await loadEntity(userEmail, identityKey));

  // Archived is the absolute override and is read straight off live metadata —
  // it beats even a manual override (a user can't pin an archived chat to a
  // tier; Read Me §4). Compute the deterministic verdict first so we know if
  // it's archived.
  const parentCommunity =
    entity && entity.community_id
      ? opts.parentCommunity ?? (await loadParentCommunity(userEmail, entity.community_id))
      : null;

  const computed = computeTier(entity, parentCommunity);

  if (computed.tier === TIER_IGNORE) {
    // Absolute: nothing stored, nothing written.
    return { tier: TIER_IGNORE, reason: computed.reason, source: 'archived' };
  }

  // Manual override wins over the computed default for the two real tiers.
  const override = await loadOverride(userEmail, identityKey);
  if (override && override.source === 'manual') {
    return { tier: override.tier, reason: 'manual-override', source: 'manual' };
  }

  // Otherwise the computed tier is effective. Record/refresh the bootstrap row.
  // Bootstrap is non-provisional (confirmed=true) for the deterministic cases,
  // since mute/size/admin are readable facts (Read Me §7); we only leave it
  // unconfirmed when the classification hinged on an UNKNOWN we had to default
  // (e.g. a group whose admin AND community-admin were both unknown).
  const hingedOnUnknown =
    computed.reason === 'group-default' &&
    entity &&
    entity.is_admin == null &&
    (entity.community_id ? entity.community_is_admin == null : false);

  await recordBootstrap(
    userEmail,
    cardId,
    identityKey,
    computed.tier,
    computed.reason,
    !hingedOnUnknown,
  );

  return {
    tier: computed.tier,
    reason: computed.reason,
    source: override ? 'bootstrap' : 'bootstrap',
  };
}

// ---------------------------------------------------------------------------
// Batch helper: classify many identity keys in one pass, loading all entities
// and communities up front. Returns Map<identity_key, {tier, reason, source}>.
// The Phase 3 pipeline uses this to route a run's entity-days without N queries.
// ---------------------------------------------------------------------------
export async function classifyMany(userEmail, identityKeys, opts = {}) {
  const keys = Array.from(new Set((identityKeys || []).filter(Boolean)));
  const out = new Map();
  if (keys.length === 0) return out;

  const [{ data: entities }, { data: overrides }] = await Promise.all([
    admin.from('whatsapp_entity').select('*').eq('user_email', userEmail).in('identity_key', keys),
    admin
      .from('whatsapp_classification')
      .select('identity_key, tier, source')
      .eq('user_email', userEmail)
      .in('identity_key', keys),
  ]);

  const entityByKey = new Map((entities || []).map((e) => [e.identity_key, e]));
  const overrideByKey = new Map((overrides || []).map((o) => [o.identity_key, o]));

  // Preload any parent communities referenced by subgroups in this batch.
  const parentIds = Array.from(
    new Set((entities || []).map((e) => e.community_id).filter(Boolean)),
  );
  let parentByKey = new Map();
  if (parentIds.length > 0) {
    const { data: parents } = await admin
      .from('whatsapp_entity')
      .select('identity_key, wa_entity_type, is_admin, archived')
      .eq('user_email', userEmail)
      .in('identity_key', parentIds);
    parentByKey = new Map((parents || []).map((p) => [p.identity_key, p]));
  }

  for (const key of keys) {
    const entity = entityByKey.get(key) || null;
    const parent = entity && entity.community_id ? parentByKey.get(entity.community_id) || null : null;
    const computed = computeTier(entity, parent);

    if (computed.tier === TIER_IGNORE) {
      out.set(key, { tier: TIER_IGNORE, reason: computed.reason, source: 'archived' });
      continue;
    }
    const override = overrideByKey.get(key);
    if (override && override.source === 'manual') {
      out.set(key, { tier: override.tier, reason: 'manual-override', source: 'manual' });
      continue;
    }
    const hingedOnUnknown =
      computed.reason === 'group-default' &&
      entity &&
      entity.is_admin == null &&
      (entity.community_id ? entity.community_is_admin == null : false);
    await recordBootstrap(userEmail, opts.cardId || 'whatsapp', key, computed.tier, computed.reason, !hingedOnUnknown);
    out.set(key, { tier: computed.tier, reason: computed.reason, source: 'bootstrap' });
  }

  return out;
}
