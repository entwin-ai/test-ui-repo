-- ============================================================================
-- Google Drive ingestion (migration 0021).
--
-- Companion to the "Google Drive Ingestion Rules: Read Me" (v1, 2026-08-01).
-- Drive is NOT an event stream like Gmail — it is a set of living folders/files
-- the user selects, read in full on first connection and diff-based thereafter
-- (§1). To support that we need one thing Gmail didn't: a per-file ledger that
-- remembers what we last saw (content hash + Drive's own modifiedTime + version)
-- so the daily scan can tell "changed / unchanged / new" without re-reading the
-- whole file, and so we never emit more than one Memory Note per file per day
-- unless the user forces a refresh (§1, Same-day multiplicity).
--
-- Notes themselves keep flowing through the EXISTING memory pipeline
-- (memory_note -> note_chunk -> entity -> entity_mention), exactly like WhatsApp
-- and Slack did (see 0006 header). Those tables are keyed by user_email and
-- carry a generic `source`, so a Drive note unifies into the same entity graph
-- and retrieval index for free. This migration therefore only adds:
--   1. drive_file        — the per-file diff ledger (the one genuinely new table)
--   2. a few nullable memory_note columns for Drive-specific facets (which file,
--      which page/slide/tab a per-page/per-tab note came from — §3 Excel, §4
--      large-file split), all additive and defaulted so nothing else regresses.
--
-- RLS: force-RLS-no-policies, identical posture to every other table (0002).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-file diff ledger.
--
-- One row per (user, card, Drive file id). The daily scan compares Drive's
-- current modifiedTime / version / md5Checksum against what's stored here to
-- decide whether the file changed since we last ingested it. content_hash is
-- our own hash of the extracted text+audit-trail (used when Drive can't give a
-- reliable checksum, e.g. Google-native Docs/Sheets/Slides, which have no
-- md5Checksum). last_note_date is the calendar date of the most recent note we
-- wrote for this file — the "one note per file per day" gate reads it.
-- ---------------------------------------------------------------------------
create table if not exists drive_file (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null,                 -- 'drive-personal' | 'drive-professional'

  -- Drive identity + where we found it.
  file_id        text not null,                 -- Drive file id (stable across renames)
  folder_id      text,                          -- the SELECTED folder this file was under
  name           text,                          -- current file name (label only)
  mime_type      text,                          -- Drive mimeType at last read

  -- Change-detection inputs. All nullable: Google-native files have no
  -- md5Checksum, some responses omit version, etc. The scan uses whichever are
  -- present, falling back to content_hash.
  drive_modified_time timestamptz,              -- Drive's own file.modifiedTime
  drive_version       text,                     -- Drive's file.version (monotonic string)
  md5_checksum        text,                     -- Drive's md5Checksum (binary uploads only)
  content_hash        text,                     -- OUR sha256 of extracted text+audit trail

  -- Bookkeeping for the cadence rules (§1).
  first_ingested_at   timestamptz not null default now(),
  last_ingested_at    timestamptz not null default now(),
  last_note_date      date,                      -- date of the newest note for this file
  note_count          int not null default 0,    -- how many notes this file has produced
  is_large            boolean not null default false, -- crossed the per-page split threshold (§4)

  updated_at     timestamptz not null default now(),

  -- One ledger row per file per user per card.
  unique (user_email, card_id, file_id)
);

create index if not exists drive_file_user_card_idx
  on drive_file (user_email, card_id);
create index if not exists drive_file_folder_idx
  on drive_file (user_email, card_id, folder_id);

-- ---------------------------------------------------------------------------
-- 2. Memory-note Drive facets.
--
-- The pipeline writes Drive notes into the same memory_note table. These
-- nullable columns let a note say WHICH Drive file it came from and, for the
-- decomposed cases (Excel per-tab §3, large-file per-page §4), which facet —
-- without needing a Drive-specific note table. drive_note_kind records the
-- decomposition granularity so the graph/UI can group a file's page notes.
-- ---------------------------------------------------------------------------
alter table memory_note
  add column if not exists drive_file_id   text,   -- Drive file id this note came from
  add column if not exists drive_facet      text,  -- 'tab:Sheet1' | 'page:5' | 'slide:12' | null
  add column if not exists drive_note_kind  text;   -- 'file' | 'tab' | 'page' | 'slide' | 'unreadable'

comment on column memory_note.drive_note_kind is
  'Granularity of a Google-Drive-sourced note: file (one note per file, the '
  'default), tab (Excel/Sheets, one note per tab §3), page/slide (large-file '
  'per-page/per-slide split §4), or unreadable (password-protected PDF §3 — '
  'metadata-only note, no content gist). Null for non-Drive notes.';

-- ---------------------------------------------------------------------------
-- 3. RLS — same force-no-policies posture as every other table (0002).
-- ---------------------------------------------------------------------------
alter table drive_file enable row level security;
alter table drive_file force  row level security;
-- No policies => anon & authenticated see zero rows; only service_role (worker
-- + server route handlers, which always add the user_email filter) bypasses.
