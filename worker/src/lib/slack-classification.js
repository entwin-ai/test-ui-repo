import { admin } from './supabase.js';

// Slack tier classification (Slack Ingestion Read Me §3-6, §8).
//
// Every Slack entity-day lands in exactly one of three outcomes:
//   Ignore    -> produce NOTHING (no note, no gist, no rollup)   [Read Me §3,4]
//   Updates   -> one gist line per channel-day                   [Read Me §3,5]
//   Important -> a full facet-split Memory Note per facet         [Read Me §3]
//
// Unlike WhatsApp, Slack's tier is keyed to ENTITY TYPE itself, not to a
// size/mute/admin cascade (Read Me §5): individuals, external connections, group
// chats, and closed channels are Important BY TYPE; public channels are Updates
// BY TYPE. There is no admin-override exception (Read Me §5) — the entity type
// is unambiguous, so there is nothing for an override to resolve.
//
// Ignore is not a stored tier — it IS the archived state, read LIVE off
// slack_entity every run and treated as an ABSOLUTE override that beats even a
// manual Kanban placement (Read Me §4: a user unarchives inside Slack, not in
// Entwin). Muting is a NO-OP for classification (Read Me §4): it never changes
// which tier an entity-day lands in.
//
// The effective tier for a run:
//   1. archived         -> IGNORE            (absolute; beats manual)
//   2. manual override  -> that tier         (user intent beats the type default)
//   3. type default     -> UPDATES | IMPORTANT (Read Me §5, §8 bootstrap)
//
// "null = unknown" contract: an archived field the layer didn't surface is null,
// NOT false, and is treated as NOT archived rather than guessed true.

export const TIER_IGNORE = 'ignore';
export const TIER_UPDATES = 'updates';
export const TIER_IMPORTANT = 'important';

// Entity types that are Important by type (Read Me §5, §8 bootstrap).
const IMPORTANT_TYPES = new Set([
  'individual',
  'external',
  'group_chat',
  'closed_channel',
]);

// ---------------------------------------------------------------------------
// Deterministic type-keyed tier for a single slack_entity row. Pure function of
// the entity's type + live archived state. Returns { tier, reason }.
// ---------------------------------------------------------------------------
export function computeTier(entity) {
  if (!entity) return { tier: TIER_IMPORTANT, reason: 'no-metadata-default' };

  // 1. ARCHIVED -> IGNORE. Absolute, first, EVERY entity type incl. public
  //    channels (Read Me §4). null archived = unknown = treat as not archived.
  if (entity.archived === true) {
    return { tier: TIER_IGNORE, reason: 'archived' };
  }

  const type = entity.slack_entity_type;

  // 2. PUBLIC CHANNELS -> UPDATES by type (Read Me §5). No size/mention/admin
  //    trigger decides membership — a public channel is Updates because it is a
  //    public channel.
  if (type === 'public_channel') {
    return { tier: TIER_UPDATES, reason: 'public-channel-default' };
  }

  // 3. INDIVIDUALS / EXTERNAL / GROUP CHATS / CLOSED CHANNELS -> IMPORTANT by
  //    type (Read Me §5, §8). Muting is a no-op (Read Me §4) — not consulted.
  if (IMPORTANT_TYPES.has(type)) {
    return { tier: TIER_IMPORTANT, reason: `${type}-default` };
  }

  // Fallback for an unrecognized type: treat as Important so nothing is silently
  // dropped into a gist.
  return { tier: TIER_IMPORTANT, reason: 'unknown-type-default' };
}

async function loadOverride(userEmail, cardId, identityKey) {
  const { data } = await admin
    .from('slack_classification')
    .select('tier, confirmed, source')
    .eq('user_email', userEmail)
    .eq('card_id', cardId)
    .eq('identity_key', identityKey)
    .maybeSingle();
  return data || null;
}

// Persist a bootstrap placement so the Kanban can show the entity. Never
// overwrites a manual row. Best-effort — Slack bootstraps are deterministic
// (entity type is readable), so they are recorded confirmed=true (Read Me §8).
async function recordBootstrap(userEmail, cardId, identityKey, tier, reason) {
  if (tier === TIER_IGNORE) return; // Ignore is never stored (Read Me §4).
  try {
    const existing = await loadOverride(userEmail, cardId, identityKey);
    if (existing && existing.source === 'manual') return; // never clobber user intent
    await admin.from('slack_classification').upsert(
      {
        user_email: userEmail,
        card_id: cardId,
        identity_key: identityKey,
        tier,
        confirmed: true, // deterministic bootstrap (Read Me §8)
        source: 'bootstrap',
        bootstrap_reason: reason,
      },
      { onConflict: 'user_email,card_id,identity_key' },
    );
  } catch (err) {
    if (!/slack_classification/.test(String(err.message))) {
      console.error(`[${userEmail}] slack recordBootstrap:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Batch helper: classify many identity keys in one pass, loading all entities
// and overrides up front. Returns Map<identity_key, {tier, reason, source}>.
// The pipeline uses this to route a run's entity-days without N queries.
// ---------------------------------------------------------------------------
export async function classifyMany(userEmail, identityKeys, opts = {}) {
  const cardId = opts.cardId || 'slack-workspace';
  const keys = Array.from(new Set((identityKeys || []).filter(Boolean)));
  const out = new Map();
  if (keys.length === 0) return out;

  const [{ data: entities }, { data: overrides }] = await Promise.all([
    admin
      .from('slack_entity')
      .select('*')
      .eq('user_email', userEmail)
      .eq('card_id', cardId)
      .in('identity_key', keys),
    admin
      .from('slack_classification')
      .select('identity_key, tier, source')
      .eq('user_email', userEmail)
      .eq('card_id', cardId)
      .in('identity_key', keys),
  ]);

  const entityByKey = new Map((entities || []).map((e) => [e.identity_key, e]));
  const overrideByKey = new Map((overrides || []).map((o) => [o.identity_key, o]));

  for (const key of keys) {
    const entity = entityByKey.get(key) || null;
    const computed = computeTier(entity);

    if (computed.tier === TIER_IGNORE) {
      out.set(key, { tier: TIER_IGNORE, reason: computed.reason, source: 'archived' });
      continue;
    }
    const override = overrideByKey.get(key);
    if (override && override.source === 'manual') {
      out.set(key, { tier: override.tier, reason: 'manual-override', source: 'manual' });
      continue;
    }
    await recordBootstrap(userEmail, cardId, key, computed.tier, computed.reason);
    out.set(key, { tier: computed.tier, reason: computed.reason, source: 'bootstrap' });
  }

  return out;
}

// Single-entity convenience wrapper (mirrors classifyWhatsappEntity).
export async function classifySlackEntity(userEmail, identityKey, opts = {}) {
  const m = await classifyMany(userEmail, [identityKey], opts);
  return m.get(identityKey) || { tier: TIER_IMPORTANT, reason: 'unclassified-default', source: 'bootstrap' };
}
