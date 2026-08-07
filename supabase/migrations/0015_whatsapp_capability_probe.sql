-- ============================================================================
-- WhatsApp ingestion-layer capability probe (migration 0015).
--
-- Phase 0 of the WhatsApp Ingestion Read Me build plan. Phase 0 is a
-- VERIFICATION spike, not a feature: before any of the tier/facet/Kanban code
-- in Phases 1-6 is written, we must confirm what the ingestion layer (Baileys)
-- actually exposes, because several later requirements are CONDITIONAL on it:
--
--   0.1  per-chat metadata (muted, member_count, is_admin, archived,
--        community parentage + parent-community admin state) must be readable
--        at capture time                       -> gates Phase 1 + Phase 2 rules
--   0.2  WhatsApp username must surface with a STABLE, account-tied identifier,
--        not just editable display text         -> gates Phase 1.3 + Phase 6.2.1
--   0.3  archived state must be re-readable every run (it is a LIVE override,
--        not a one-time classification)        -> gates Phase 2 Ignore tier
--
-- This migration is PURELY ADDITIVE: one new table that stores the machine-
-- readable result of a probe run, so the findings are durable, queryable, and
-- reviewable in the dashboard rather than living only in a workflow log. It
-- changes NOTHING about the existing capture/vectorize path. Keyed by
-- user_email; RLS enabled + FORCED with no policies (service-layer isolation),
-- matching the rest of the schema.
-- ============================================================================

create table if not exists whatsapp_capability_probe (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'whatsapp',

  -- When the probe ran and how long the socket stayed open.
  probed_at      timestamptz not null default now(),
  socket_ms      integer,                       -- how long the short-lived socket was open

  -- ------------------------------------------------------------------------
  -- 0.1  Per-chat metadata availability. Each *_available boolean records
  --      whether the field was observed on at least one real chat during the
  --      probe; the *_sample_pct records on what fraction of eligible chats it
  --      was actually present (a field can exist on the type yet be absent on
  --      many chats — that is itself a finding Phase 2 must plan around).
  -- ------------------------------------------------------------------------
  group_type_available        boolean,          -- can we tell group from 1:1?
  community_type_available     boolean,          -- can we tell community / subgroup from a plain group?
  muted_available              boolean,
  member_count_available       boolean,
  self_admin_available         boolean,          -- user's OWN admin state in a group
  archived_available           boolean,
  community_parent_available   boolean,          -- subgroup -> parent community link
  community_admin_available    boolean,          -- user's admin state on the PARENT community

  metadata_coverage jsonb,                       -- { field -> {eligible, present, pct}, ... }

  -- ------------------------------------------------------------------------
  -- 0.2  Username durability. The decisive question for Phase 6 auto-merge:
  --      does the username come with a stable backing id, or only mutable text?
  --   'durable'   -> a stable, account-tied identifier is exposed -> auto-merge OK
  --   'text_only' -> only editable display text -> DEGRADE to fuzzy signal
  --   'absent'    -> no username surfaced at all in the probe window
  --   'unknown'   -> probe could not determine (e.g. no contact set a username)
  -- ------------------------------------------------------------------------
  username_durability text
                 check (username_durability in ('durable', 'text_only', 'absent', 'unknown')),
  username_field_path text,                      -- where it was found on the object, for the resolver spec
  username_sample_count integer,                 -- how many contacts in-sample had a username set

  -- ------------------------------------------------------------------------
  -- 0.3  Archived-state liveness. Whether archived is re-observable per run
  --      (required for the live Ignore override) and whether unarchiving is
  --      detectable as a state change.
  -- ------------------------------------------------------------------------
  archived_live_readable   boolean,
  unarchive_detectable     boolean,

  -- Raw counts for context in the report (no message BODIES are stored — this
  -- is a capability probe, not an ingestion).
  chats_seen        integer,
  groups_seen       integer,
  communities_seen  integer,
  contacts_seen     integer,

  -- Free-form notes and any warnings the probe emitted (fields that were
  -- present but ambiguous, library-version caveats, etc).
  notes           text,
  raw             jsonb,                         -- full structured probe payload for audit

  created_at      timestamptz not null default now()
);

create index if not exists whatsapp_capability_probe_user_idx
  on whatsapp_capability_probe (user_email, probed_at desc);

alter table whatsapp_capability_probe enable row level security;
alter table whatsapp_capability_probe force row level security;

-- Force PostgREST to reload its schema cache immediately so the new table is
-- visible to the API/probe layer without waiting for the periodic reload.
notify pgrst, 'reload schema';
