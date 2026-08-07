-- ============================================================================
-- WhatsApp tier classification (migration 0017).
--
-- Phase 2 of the WhatsApp Ingestion Read Me build plan. Backs the three-outcome
-- routing (Read Me §3): every WhatsApp entity-day lands in exactly ONE of
-- Ignore / Updates / Important, and only Important produces a full Memory Note.
--
-- KEY DESIGN — why this table is NOT a full tier cache:
-- WhatsApp's tier is mostly a DETERMINISTIC function of LIVE metadata (archived,
-- muted, member_count, self-admin, community-admin) that Phase 1 captures fresh
-- into whatsapp_entity every run. Caching a computed tier here would go stale the
-- moment a group is muted or archived. So the classifier COMPUTES the tier live
-- from whatsapp_entity on each run; this table stores only the two things that
-- are NOT derivable from live metadata:
--   1. a MANUAL override — the user dragged the entity between Kanban columns
--      (Read Me §7-8). manual + confirmed always wins over the computed default.
--   2. a provisional BOOTSTRAP placement recorded at first sight, so the Kanban
--      can show a brand-new entity immediately (Read Me §7 "Bootstrap default").
--
-- Note there is NO 'ignore' value here: Ignore == archived, which is a LIVE
-- state read straight off whatsapp_entity every run and an ABSOLUTE override
-- (Read Me §4). It is never a stored classification and never a Kanban bucket,
-- so a user can't "pin" an entity to Ignore — they unarchive in WhatsApp itself.
-- The two stored tiers mirror the two Kanban columns exactly (Read Me §7).
--
-- PURELY ADDITIVE: one new table. Keyed to identity_key (phone | group id |
-- community id — the SAME stable key as whatsapp_entity, never display name).
-- RLS enabled + FORCED, no policies (service-layer isolation), matching 0013.
-- ============================================================================

create table if not exists whatsapp_classification (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'whatsapp',

  -- The stable identity key this classification is for. Matches
  -- whatsapp_entity.identity_key one-to-one (phone / group id / community id).
  identity_key   text not null,

  -- Which of the TWO Kanban columns this entity sits in. There is deliberately
  -- no 'ignore' — see the header. 'updates' | 'important'.
  tier           text not null
                 check (tier in ('updates', 'important')),

  -- confirmed = the user has settled this on the Kanban (or it was placed by a
  -- deterministic rule that needs no confirmation, e.g. a new 1:1 -> important).
  -- false = provisional bootstrap placement still shown highlighted for review.
  -- Unlike email, most WhatsApp placements are NON-provisional at bootstrap
  -- (mute/size/admin are readable facts at connect time, unlike email's
  -- List-Unsubscribe guess — Read Me §7), so confirmed defaults true and only a
  -- genuinely ambiguous bootstrap sets it false.
  confirmed      boolean not null default true,

  -- How this row got here, for the Kanban's highlighting + auditability:
  --   bootstrap -> written by the deterministic rules at first sight
  --   manual    -> the user set/moved it on the Kanban (implies confirmed)
  source         text not null default 'bootstrap'
                 check (source in ('bootstrap', 'manual')),

  -- The rule that produced a bootstrap placement (e.g. 'new-1:1',
  -- 'admin-exception', 'muted', 'members>10', 'community-not-admin'), kept so the
  -- Kanban can explain WHY an entity landed where it did.
  bootstrap_reason text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One classification row per entity per user — "decided once, reused", and the
  -- manual-override anchor the Kanban writes to.
  unique (user_email, identity_key)
);

create index if not exists whatsapp_classification_user_idx
  on whatsapp_classification (user_email);
-- The Kanban groups by tier and highlights unconfirmed cards; index both.
create index if not exists whatsapp_classification_tier_idx
  on whatsapp_classification (user_email, tier);
create index if not exists whatsapp_classification_unconfirmed_idx
  on whatsapp_classification (user_email) where not confirmed;

-- Keep updated_at honest on every reclassification / confirm / manual move.
create or replace function whatsapp_classification_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists whatsapp_classification_touch on whatsapp_classification;
create trigger whatsapp_classification_touch
  before update on whatsapp_classification
  for each row
  execute function whatsapp_classification_touch_updated_at();

alter table whatsapp_classification enable row level security;
alter table whatsapp_classification force row level security;

-- ----------------------------------------------------------------------------
-- Observability: stamp the resolved tier onto each processed message row, so a
-- run's routing is auditable ("why did this chat produce no note?" -> archived)
-- without recomputing. Additive + nullable; the pipeline sets them when it
-- processes a row, historical rows stay null. Not a classification store — the
-- authoritative tier is always recomputed live from whatsapp_entity.
-- ----------------------------------------------------------------------------
alter table whatsapp_message
  add column if not exists wa_tier text
    check (wa_tier in ('ignore', 'updates', 'important'));

alter table whatsapp_message
  add column if not exists wa_tier_reason text;

-- Force PostgREST to reload its schema cache immediately so the new table is
-- visible to the API/worker layer without waiting for the periodic reload.
notify pgrst, 'reload schema';
