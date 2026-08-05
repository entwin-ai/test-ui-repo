-- ============================================================================
-- Entity-layer lineage/review + note-linking foundation (migration 0012).
--
-- Phase 1.1 of the v5-schema build plan. PURELY ADDITIVE: every change below is
-- a new column (nullable/defaulted) or a new table, so existing rows stay valid
-- and no existing field defined in earlier migrations is altered. No behavior
-- changes here — the Resolver, dashboards, and jobs that consume these land in
-- later phases. Keyed by user_email like everything else; RLS enabled + FORCED
-- with no policies (service-layer isolation), matching 0002/0004/0010.
--
-- Implements, from "The Anatomy of a Memory Note v5":
--   §7  matched_alias on each Memory Note Reference       -> entity_mention.matched_alias
--   §7  note_id -> current_entity_id ownership index       -> note_ownership table
--   §4  three-band alias matching (provisional entities)   -> entity.pending_review,
--                                                              merge_candidate, merge_score
--   §4  merge retires source (merged_into)                 -> entity.merged_into
--   §4  split adds lineage on the new entity (split_from)   -> entity.split_from
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. matched_alias on each Memory Note Reference (v5 §7).
--
-- Each reference must record WHICH alias justified it, not just the note_id, so
-- a later split can partition an entity's references by the alias that matched.
-- Existing rows predate the Resolver writing this, so it is nullable; the
-- Resolver (Phase 2) backfills it going forward. The (user_email, entity_id,
-- note_id) uniqueness is deliberately left intact: a note resolves to an entity
-- through exactly one alias per resolution, so matched_alias is an attribute of
-- that single reference, not a new dimension of uniqueness.
-- ----------------------------------------------------------------------------
alter table entity_mention
  add column if not exists matched_alias text;

-- ----------------------------------------------------------------------------
-- 2. Entity lineage + review fields (v5 §4).
--
-- Three-band alias matching: an ambiguous match creates a PROVISIONAL entity
-- flagged pending_review, carrying a pointer at the entity it might actually be
-- (merge_candidate) and the similarity score that tripped the flag (merge_score).
-- The note still attaches to this provisional entity normally — ingestion is
-- never blocked. Resolution is human-only, via the Entity Review dashboard
-- (Phase 4).
--
-- Merge/split lineage: a merge retires the source entity, marking it merged_into
-- the target (old notes' related_entities still point at it and need a redirect).
-- A split retires nothing — only the NEW entity carries split_from back to the
-- entity it was carved out of. Neither operation ever rewrites a Memory Note.
-- ----------------------------------------------------------------------------
alter table entity
  add column if not exists pending_review  boolean not null default false,
  add column if not exists merge_candidate uuid,               -- entity this might actually be
  add column if not exists merge_score     double precision,   -- similarity that tripped the flag
  add column if not exists merged_into     uuid,               -- set when this entity is retired by a merge
  add column if not exists split_from      uuid;               -- set on a new entity carved out by a split

-- Self-referential lineage pointers. ON DELETE SET NULL so removing a target
-- never cascades away a still-valid entity; the pointer just goes stale-safe.
-- Guarded with DO blocks so re-running the migration doesn't error on the
-- constraints already existing (add constraint has no IF NOT EXISTS).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'entity_merge_candidate_fkey') then
    alter table entity add constraint entity_merge_candidate_fkey
      foreign key (merge_candidate) references entity(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_merged_into_fkey') then
    alter table entity add constraint entity_merged_into_fkey
      foreign key (merged_into) references entity(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entity_split_from_fkey') then
    alter table entity add constraint entity_split_from_fkey
      foreign key (split_from) references entity(id) on delete set null;
  end if;
end $$;

-- Dashboard reads "every entity flagged pending_review for this user" often;
-- partial index keeps that scan cheap without bloating on the common (false) case.
create index if not exists entity_pending_review_idx
  on entity (user_email) where pending_review;

-- ----------------------------------------------------------------------------
-- 3. note_id -> current_entity_id ownership index (v5 §7).
--
-- A separate store, distinct from both the Memory Notes and the Entity files,
-- answering "who currently owns this note" in one lookup — without scanning
-- every Entity file and without reopening the frozen Memory Note. Updated on
-- every entity-layer write (create, append, merge, split) by the Resolver in
-- Phase 2. A note can be owned by more than one entity over time only in the
-- sense of multiple related_entities; ownership here tracks the CURRENT resolved
-- entity per (note, originally-resolved entity) lineage, so the key is the note
-- plus which reference we are tracking. We key by (user_email, note_id,
-- resolved_entity_id) and carry current_entity_id as the possibly-redirected
-- owner, so a merge/split updates current_entity_id while the original anchor
-- (resolved_entity_id, matched_alias) stays put — exactly what the two-field
-- note display in v5 §7 needs ("resolved at ingestion" vs "current entity").
-- ----------------------------------------------------------------------------
create table if not exists note_ownership (
  id                 uuid primary key default uuid_generate_v4(),
  user_email         text not null,
  note_id            uuid not null references memory_note(id) on delete cascade,
  -- the entity this reference resolved to AT INGESTION (frozen anchor)
  resolved_entity_id uuid not null references entity(id) on delete cascade,
  -- the entity that CURRENTLY owns it (== resolved_entity_id until a merge/split
  -- redirects it). This is the answer to "who owns this note now".
  current_entity_id  uuid not null references entity(id) on delete cascade,
  -- which alias justified this reference (mirrors entity_mention.matched_alias),
  -- so a split can partition ownership by alias the same way.
  matched_alias      text,
  updated_at         timestamptz not null default now(),
  unique (user_email, note_id, resolved_entity_id)
);
create index if not exists note_ownership_user_idx    on note_ownership (user_email);
create index if not exists note_ownership_note_idx    on note_ownership (user_email, note_id);
create index if not exists note_ownership_current_idx on note_ownership (user_email, current_entity_id);

-- Keep updated_at honest on every redirect.
create or replace function note_ownership_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists note_ownership_touch on note_ownership;
create trigger note_ownership_touch
  before update on note_ownership
  for each row
  execute function note_ownership_touch_updated_at();

-- RLS: same posture as the rest — enabled + forced, no policies, service_role
-- only. entity/entity_mention already have RLS from 0004; only the new table
-- needs it set here.
alter table note_ownership enable row level security;
alter table note_ownership force row level security;
