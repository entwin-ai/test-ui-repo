-- ============================================================================
-- WhatsApp per-entity metadata + identity foundation (migration 0016).
--
-- Phase 1 of the WhatsApp Ingestion Read Me build plan. Everything the tier
-- classifier (Phase 2) and the WhatsApp Kanban (Phase 5) decide against is
-- ENTITY-grained (per contact / group / community), not message-grained, so it
-- does not belong on the message ledger. This migration adds:
--
--   1. whatsapp_entity  — one row per WhatsApp entity (person | group |
--      community) holding the structural + live metadata Phase 2 rules read:
--      muted, member_count, is_admin, archived, community parentage, and the
--      parent community's admin state. Identity is keyed to phone number (person)
--      or group/community id (group/community) — NEVER display name (Read Me §2).
--   2. Two additive columns on whatsapp_message (wa_entity_type, community_id)
--      so a captured message already carries the discriminator downstream,
--      without a join, the same way is_group (0008) already does.
--
-- PURELY ADDITIVE: a new table plus nullable/defaulted columns. No existing
-- field is altered; the current capture/vectorize path keeps working unchanged
-- (the new columns are populated by the Phase 1.2 capture change, and simply
-- stay null until that ships). The WhatsApp USERNAME is NOT stored here — per
-- Read Me §2 it is a SECONDARY ALIAS on the shared Entity file (entity.aliases,
-- migration 0004), never a replacement for the phone-number key, so it is
-- written by the resolver/capture into that existing column, not a new one.
--
-- Keyed by user_email; RLS enabled + FORCED with no policies (service-layer
-- isolation), matching the rest of the schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. whatsapp_entity — the per-entity metadata store.
--
-- identity_key is the STABLE key the classifier and Kanban join on:
--   person     -> phone number (e.g. '+13125551234')
--   group      -> group id      (the '...@g.us' jid)
--   community  -> community id  (the community jid)
-- chat_jid keeps the raw jid as captured (may equal identity_key for groups).
-- display_name is a LABEL only — deliberately never the key (two contacts can
-- share a name; one contact can change theirs), mirroring email's exact-address
-- rule (Read Me §2).
-- ----------------------------------------------------------------------------
create table if not exists whatsapp_entity (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'whatsapp',

  -- Identity (Read Me §2). Keyed to phone / group id / community id, never name.
  wa_entity_type text not null
                 check (wa_entity_type in ('person', 'group', 'community')),
  identity_key   text not null,                 -- phone number | group id | community id
  chat_jid       text,                          -- raw remoteJid as captured
  display_name   text,                          -- LABEL only, never the identity key

  -- Live per-entity metadata the Phase 2 rules read. All nullable: a field the
  -- ingestion layer did not surface this run stays null, and Phase 2 must treat
  -- null as "unknown" with the fallback recorded in the Phase 0 decision record
  -- (e.g. unknown admin -> treat as non-admin). muted/archived are LIVE state,
  -- re-read every run (Read Me §4: archived is an absolute, live override).
  muted            boolean,
  member_count     integer,                     -- groups/communities only
  is_admin         boolean,                     -- user's OWN admin state in this group/community
  archived         boolean,
  community_id     text,                         -- parent community id for a subgroup (null otherwise)
  community_is_admin boolean,                    -- user's admin state on the PARENT community

  -- Read Me §2: the WhatsApp username, when a contact has set one, is a SECONDARY
  -- ALIAS on the shared Entity file — never a replacement for the phone-number
  -- identity key. Capture stashes the username here (person entities only); the
  -- resolver (Phase 6) promotes it into entity.aliases at auto-merge confidence
  -- ONLY IF the Phase 0 probe (0.2) confirmed it is backed by a stable,
  -- account-tied identifier. Until then it is inert reference data, not a match
  -- key. username_is_durable carries that per-value verdict forward for Phase 6.
  wa_username        text,
  username_is_durable boolean,

  -- Bookkeeping so capture can tell "seen this run" from stale, and so a later
  -- phase can spot an entity that has gone silent.
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  metadata_updated_at timestamptz,              -- last time any live field changed

  created_at     timestamptz not null default now(),

  -- One row per entity per user. identity_key is the natural key; capture
  -- upserts on it.
  unique (user_email, identity_key)
);

create index if not exists whatsapp_entity_user_idx
  on whatsapp_entity (user_email);
-- Phase 2 groups by type and filters archived first; index both dimensions.
create index if not exists whatsapp_entity_type_idx
  on whatsapp_entity (user_email, wa_entity_type);
create index if not exists whatsapp_entity_archived_idx
  on whatsapp_entity (user_email) where archived;
-- A community's subgroups are looked up by their parent (the cascade in §5).
create index if not exists whatsapp_entity_community_idx
  on whatsapp_entity (user_email, community_id) where community_id is not null;

-- Keep metadata_updated_at honest whenever a live field actually changes. We
-- only bump it when one of the metadata columns differs, so an idempotent
-- re-upsert of unchanged metadata does not churn the timestamp.
create or replace function whatsapp_entity_touch_metadata()
returns trigger
language plpgsql
as $$
begin
  new.last_seen_at = now();
  if new.muted            is distinct from old.muted
     or new.member_count  is distinct from old.member_count
     or new.is_admin      is distinct from old.is_admin
     or new.archived      is distinct from old.archived
     or new.community_id  is distinct from old.community_id
     or new.community_is_admin is distinct from old.community_is_admin then
    new.metadata_updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists whatsapp_entity_touch on whatsapp_entity;
create trigger whatsapp_entity_touch
  before update on whatsapp_entity
  for each row
  execute function whatsapp_entity_touch_metadata();

alter table whatsapp_entity enable row level security;
alter table whatsapp_entity force row level security;

-- ----------------------------------------------------------------------------
-- 2. Message-ledger discriminator columns.
--
-- is_group (0008) is a boolean only. Phase 2 needs three-way type + community
-- parentage on the message itself so downstream can route without a join. Both
-- additive and nullable; capture (Phase 1.2) populates them, and they stay null
-- on historical rows until reprocessed. is_group is kept for back-compat.
-- ----------------------------------------------------------------------------
alter table whatsapp_message
  add column if not exists wa_entity_type text
    check (wa_entity_type in ('person', 'group', 'community'));

alter table whatsapp_message
  add column if not exists community_id text;   -- parent community id if the chat is a subgroup

-- Backfill the obvious cases from what we already know (is_group + jid shape):
-- a '@g.us' chat is at least a group; a non-group chat is a person. Community
-- vs plain group can only be told from group metadata at capture time, so
-- existing group rows stay 'group' until re-captured — never guessed here.
update whatsapp_message
  set wa_entity_type = case when is_group then 'group' else 'person' end
  where wa_entity_type is null;

-- Force PostgREST to reload its schema cache immediately so the new table and
-- columns are visible to the API/capture layer without waiting for the periodic
-- reload (the "Could not find the column ... in the schema cache" symptom).
notify pgrst, 'reload schema';
