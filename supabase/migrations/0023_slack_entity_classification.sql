-- ============================================================================
-- Slack per-entity metadata + tier classification (migration 0023).
--
-- Implements the Slack Ingestion Read Me build plan (the Slack analogue of the
-- WhatsApp Phase 1/2 migrations 0016 + 0017). Where migration 0009 made Slack a
-- first-class ingestion source (the slack_message ledger + memory-note link),
-- this migration adds the ENTITY-grained layer the three-tier classifier
-- (Read Me §2-7) and the two-column Slack Kanban (Read Me §8) decide against:
--
--   1. slack_entity          — one row per Slack entity, keyed to a DURABLE
--      platform ID (Read Me §2): individual -> user ID, group chat -> group DM
--      conversation ID, closed channel -> channel ID, public channel -> channel
--      ID, external connection -> shape-dependent key (Read Me §7). Holds the
--      structural + live metadata the classifier reads: entity type, archived
--      (the live Ignore-tier state, Read Me §4), and the external-connection
--      shape.
--   2. slack_classification  — the two STORED Kanban tiers (updates | important)
--      plus the manual-override / bootstrap bookkeeping. There is deliberately
--      NO 'ignore' value: Ignore == archived, a LIVE state read straight off
--      slack_entity every run and an ABSOLUTE override (Read Me §4), never a
--      stored tier or a Kanban column.
--   3. Two observability columns on slack_message (slack_entity_type, slack_tier
--      /slack_tier_reason) so a run's routing is auditable without recompute.
--
-- Identity is ALWAYS keyed to the durable platform ID, never the display name
-- (Read Me §2), the same principle as WhatsApp's phone-number rule and email's
-- exact-address rule. Entity keys are scoped per workspace (card_id), since the
-- same numeric/string ID has no guaranteed meaning across two workspaces
-- (Read Me §12).
--
-- PURELY ADDITIVE: two new tables plus nullable/defaulted columns. The existing
-- capture/vectorize path keeps working; the new columns simply stay null until
-- the Phase 1 capture change populates them. RLS enabled + FORCED, no policies
-- (service-layer isolation), matching the rest of the schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. slack_entity — the per-entity metadata store.
--
-- identity_key is the STABLE key the classifier and Kanban join on (Read Me §2):
--   individual           -> Slack user ID          (U…)
--   group chat (mpim)     -> group DM conversation ID (G…/D… as Slack assigns)
--   closed channel        -> channel ID             (C…, private)
--   public channel        -> channel ID             (C…, public)
--   external (1:1 DM)      -> external user ID
--   external (org-wide)    -> external organization ID  (Read Me §7)
--   external (channel)     -> channel ID
-- display_name is a LABEL only — never the key (a handle/name can change or a
-- channel be renamed/reused; the ID cannot), mirroring email's exact-address
-- rule (Read Me §2).
-- ----------------------------------------------------------------------------
create table if not exists slack_entity (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'slack-workspace',  -- per-workspace (Read Me §12)

  -- Identity (Read Me §2). Keyed to a durable platform ID, never display name.
  --   individual | group_chat | closed_channel | public_channel | external
  slack_entity_type text not null
                 check (slack_entity_type in
                   ('individual', 'group_chat', 'closed_channel', 'public_channel', 'external')),
  identity_key   text not null,                 -- user id | channel id | group DM id | external org/user id
  channel_id     text,                          -- raw Slack conversation id as captured
  display_name   text,                          -- LABEL only, never the identity key

  -- Live per-entity metadata the classifier reads. archived is LIVE state,
  -- re-read every run (Read Me §4: archived is an absolute, live override).
  -- null = unknown; the classifier treats unknown archived as NOT archived
  -- rather than guessing true (the Phase 0 "null = unknown" contract).
  archived       boolean,

  -- External-connection shape (Read Me §7). Only meaningful when
  -- slack_entity_type = 'external'; null otherwise. Drives the identity
  -- granularity: 'dm' (per external user), 'org' (per external org), 'channel'
  -- (per external channel). Read at connection time, never inferred from
  -- message content.
  external_shape text
                 check (external_shape in ('dm', 'org', 'channel')),
  external_org_id text,                         -- the partner org id for an org-wide connect

  -- Bookkeeping.
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  metadata_updated_at timestamptz,              -- last time any live field changed

  created_at     timestamptz not null default now(),

  -- One row per entity per user per workspace. identity_key is unique within a
  -- workspace (card_id) — Read Me §12: IDs are workspace-scoped.
  unique (user_email, card_id, identity_key)
);

create index if not exists slack_entity_user_idx
  on slack_entity (user_email);
-- The classifier groups by type and filters archived first; index both.
create index if not exists slack_entity_type_idx
  on slack_entity (user_email, card_id, slack_entity_type);
create index if not exists slack_entity_archived_idx
  on slack_entity (user_email) where archived;

-- Keep metadata_updated_at honest whenever a live field actually changes.
create or replace function slack_entity_touch_metadata()
returns trigger
language plpgsql
as $$
begin
  new.last_seen_at = now();
  if new.archived        is distinct from old.archived
     or new.external_shape is distinct from old.external_shape
     or new.external_org_id is distinct from old.external_org_id then
    new.metadata_updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists slack_entity_touch on slack_entity;
create trigger slack_entity_touch
  before update on slack_entity
  for each row
  execute function slack_entity_touch_metadata();

alter table slack_entity enable row level security;
alter table slack_entity force row level security;

-- ----------------------------------------------------------------------------
-- 2. slack_classification — the two STORED Kanban tiers + manual/bootstrap.
--
-- Like WhatsApp's, this is NOT a full tier cache: the effective tier is a
-- DETERMINISTIC function of entity type + live archived state (Read Me §3-5),
-- computed live every run. This table stores only the two things NOT derivable
-- from live metadata:
--   1. a MANUAL override — the user moved the entity between Kanban columns
--      (Read Me §8). manual always wins over the computed default.
--   2. a BOOTSTRAP placement recorded at first sight so the Kanban shows the
--      entity immediately. Slack bootstraps are FULLY DETERMINISTIC (entity type
--      is readable at connection time — Read Me §8), so confirmed defaults true
--      with no provisional guessing, unlike email's List-Unsubscribe guess.
--
-- No 'ignore' value: Ignore == archived (Read Me §4), a live absolute override,
-- never stored, never a column.
-- ----------------------------------------------------------------------------
create table if not exists slack_classification (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,
  card_id        text not null default 'slack-workspace',

  identity_key   text not null,                 -- matches slack_entity.identity_key

  tier           text not null
                 check (tier in ('updates', 'important')),

  confirmed      boolean not null default true, -- Slack placements are deterministic -> true

  source         text not null default 'bootstrap'
                 check (source in ('bootstrap', 'manual')),

  bootstrap_reason text,                        -- e.g. 'public-channel-default', 'individual-default'

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One classification row per entity per user per workspace.
  unique (user_email, card_id, identity_key)
);

create index if not exists slack_classification_user_idx
  on slack_classification (user_email);
create index if not exists slack_classification_tier_idx
  on slack_classification (user_email, card_id, tier);
create index if not exists slack_classification_unconfirmed_idx
  on slack_classification (user_email) where not confirmed;

create or replace function slack_classification_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists slack_classification_touch on slack_classification;
create trigger slack_classification_touch
  before update on slack_classification
  for each row
  execute function slack_classification_touch_updated_at();

alter table slack_classification enable row level security;
alter table slack_classification force row level security;

-- ----------------------------------------------------------------------------
-- 3. Message-ledger discriminator + observability columns.
--
-- slack_entity_type lets a captured message carry its type downstream without a
-- join. slack_tier / slack_tier_reason stamp the resolved routing onto each
-- processed row so "why did this channel produce no note?" -> archived is
-- auditable. All additive + nullable; historical rows stay null.
-- ----------------------------------------------------------------------------
alter table slack_message
  add column if not exists slack_entity_type text
    check (slack_entity_type in
      ('individual', 'group_chat', 'closed_channel', 'public_channel', 'external'));

alter table slack_message
  add column if not exists slack_tier text
    check (slack_tier in ('ignore', 'updates', 'important'));

alter table slack_message
  add column if not exists slack_tier_reason text;

-- Attachments (Read Me §9). Slack files/attachments posted in a message are
-- captured here as a JSONB array of {id, name, mimetype, url, title}. Any
-- attachment in Important-tier activity gets its OWN linked Memory Note (see the
-- pipeline); Updates-tier attachments are dropped entirely (Read Me §9). Kept on
-- the ledger row so re-vectorizing can re-derive the attachment notes without
-- re-hitting the Slack API.
alter table slack_message
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- Read Me §9 — an attachment's Memory Note carries a locator back to the parent
-- message + thread. We mark such notes and link them to the parent Slack ledger
-- row so the original context is always reachable from the attachment note.
alter table memory_note
  add column if not exists slack_is_attachment boolean not null default false;

-- ----------------------------------------------------------------------------
-- 4. Slack Updates daily rollup + Ignore audit are handled by the existing
--    daily_rollup table (migration 0001) via kinds 'slack_updates' and
--    (optional) 'slack_ignored'. No schema change needed — daily_rollup is
--    already keyed by (user_email, card_id, rollup_date, kind).
-- ----------------------------------------------------------------------------

-- Force PostgREST to reload its schema cache immediately so the new tables and
-- columns are visible to the API/worker layer without waiting for the periodic
-- reload.
notify pgrst, 'reload schema';
