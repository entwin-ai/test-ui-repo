-- ============================================================================
-- Slack channel + cross-channel memory (migration 0009).
--
-- Goal: make Slack a first-class ingestion source through the SAME memory
-- pipeline as Gmail and WhatsApp (memory_note -> note_chunk -> entity), so that
--   * RAG (/api/ask) answers over email + WhatsApp + Slack together, and
--   * the memory map (/api/graph) unifies an entity across all three channels.
--
-- Slack is pull-based (Web API, no persistent socket), so unlike WhatsApp both
-- CAPTURE and VECTORIZE run inside the GitHub Actions worker in one bounded job:
-- the worker uses the user token stored in Redis (written by the OAuth callback)
-- to pull the last 1 month of messages into slack_message, then vectorizes the
-- unprocessed rows. This mirrors the Gmail backfill dispatch model exactly.
--
-- Keyed by (user_email, card_id) like everything else; the memory tables were
-- already generalized for multiple sources in migration 0006, so a Slack note
-- with source='slack' unifies into the same entity graph and retrieval index
-- automatically.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Raw Slack message ledger — the Slack analogue of email_message /
--    whatsapp_message. Written and consumed by the GitHub Actions worker:
--    the capture step upserts rows (idempotent on (user_email, slack_msg_ts)),
--    the vectorize step turns processed_at IS NULL rows into memory notes.
-- ----------------------------------------------------------------------------
create table if not exists slack_message (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'slack-workspace',
  slack_msg_ts   text not null,                 -- Slack message ts (unique per channel)
  channel_id     text not null,                 -- conversation id (C…, D…, G…)
  channel_name   text,                          -- #channel, DM/group label
  channel_type   text,                          -- public | private | im | mpim
  sender         text,                          -- Slack user id of author
  sender_name    text,                          -- best-effort display name
  from_me        boolean not null default false,
  msg_timestamp  timestamptz not null,          -- when the message was sent
  body           text,                          -- message text
  permalink      text,                          -- deep link back into Slack
  processed_at   timestamptz,                   -- set once a memory note is written
  process_error  text,
  schema_version int not null default 1,
  created_at     timestamptz not null default now(),
  -- ts is unique within a channel; scope the ledger key by channel to be safe.
  unique (user_email, channel_id, slack_msg_ts)
);
create index on slack_message (user_email, card_id);
create index on slack_message (user_email, channel_id);
-- The worker's vectorize query: this user's not-yet-processed messages, oldest
-- first. Partial index keeps that scan cheap as the processed backlog grows.
create index if not exists slack_message_unprocessed_idx
  on slack_message (user_email, msg_timestamp)
  where processed_at is null;

alter table slack_message enable row level security;
alter table slack_message force row level security;

-- ----------------------------------------------------------------------------
-- 2. Link memory_note to the Slack ledger. memory_note.gmail_msg_id was already
--    made nullable and source_ref added in migration 0006; we only add the
--    slack_message foreign key (null for non-Slack notes).
-- ----------------------------------------------------------------------------
alter table memory_note
  add column if not exists slack_message_id uuid references slack_message(id) on delete cascade;

create index if not exists memory_note_slack_idx on memory_note (user_email, slack_message_id);

-- note_chunk is already source-agnostic (references memory_note + carries
-- user_email/card_id), so Slack chunks land in the same ivfflat index and
-- hybrid retrieval spans all three channels with no RPC change.

-- ----------------------------------------------------------------------------
-- 3. sync_state: allow a 'slack' channel row per user with its own cursors.
--    Gmail uses last_history_id/backfill_cursor; WhatsApp uses wa_* columns;
--    Slack reuses backfill_done + adds slack_backfill_after (the 1-month floor)
--    and slack_last_processed_ts (the delta high-water mark).
-- ----------------------------------------------------------------------------
alter table sync_state
  add column if not exists slack_backfill_after timestamptz;     -- ingest floor (now - 1 month)

alter table sync_state
  add column if not exists slack_last_processed_ts timestamptz;  -- delta high-water mark

-- ----------------------------------------------------------------------------
-- 4. Convenience RPC: per-user Slack ingestion progress, for the UI card.
--    Mirrors whatsapp_stats.
-- ----------------------------------------------------------------------------
create or replace function slack_stats (p_user_email text)
returns table (
  total_messages     bigint,
  processed_messages bigint,
  channels           bigint,
  earliest           timestamptz,
  latest             timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    count(*)                                            as total_messages,
    count(*) filter (where processed_at is not null)    as processed_messages,
    count(distinct channel_id)                          as channels,
    min(msg_timestamp)                                  as earliest,
    max(msg_timestamp)                                  as latest
  from slack_message
  where user_email = p_user_email;
$$;

revoke all on function slack_stats(text) from public, anon, authenticated;
