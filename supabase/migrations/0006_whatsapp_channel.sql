-- ============================================================================
-- WhatsApp channel + cross-channel memory (migration 0006).
--
-- Goal: make WhatsApp a first-class ingestion source that flows through the
-- SAME memory pipeline as Gmail (memory_note -> note_chunk -> entity), so that
--   * RAG (/api/ask) answers over email AND WhatsApp together, and
--   * the memory map (/api/graph) treats every entity as cross-channel — one
--     "Priya Menon" bubble whether she appears in an email, a WhatsApp chat,
--     or both.
--
-- Design principle that makes this cheap: memory_note / note_chunk / entity /
-- entity_mention were already keyed by user_email (NOT by card or source), and
-- memory_note already has a `source` column. The entity resolver and the graph
-- RPCs key purely on user_email. So a note written from WhatsApp with the same
-- shape as a Gmail note is automatically unified into the same entity graph and
-- the same retrieval index. This migration therefore does three things:
--   1. Adds a raw WhatsApp message ledger (idempotency + delta cursor source).
--   2. Generalizes the memory tables so a note can point at a WhatsApp message
--      instead of a Gmail message (the gmail_msg_id NOT NULL constraint is
--      relaxed; a generic source_ref is added).
--   3. Extends sync_state with WhatsApp backfill/delta bookkeeping and adds a
--      channel column so one user can have a gmail row and a whatsapp row.
--
-- Keyed by (user_email, card_id) like everything else; isolation enforced in
-- the service layer (service_role bypasses RLS; every query carries user_email).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Raw WhatsApp message ledger — the WhatsApp analogue of email_message.
--    Written by the PERSISTENT Next server (the Baileys capture bridge) as
--    messages arrive, then consumed by the GitHub Actions worker which turns
--    unprocessed rows into memory notes + embeddings. Splitting "capture" from
--    "vectorize" this way is what lets the heavy LLM/embedding work run in
--    Actions on an hourly cron while the always-on process only does the light
--    job of persisting raw messages (Baileys needs a live socket; Actions
--    cannot hold one — see worker/README and the connect route).
-- ----------------------------------------------------------------------------
create table if not exists whatsapp_message (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)
  card_id        text not null default 'whatsapp',
  wa_msg_id      text not null,                 -- WhatsApp message key.id
  chat_id        text not null,                 -- remoteJid (the conversation)
  chat_name      text,                          -- pushName / group subject if known
  sender         text,                          -- participant jid (group) or chat_id
  sender_name    text,                          -- best-effort display name
  from_me        boolean not null default false,
  msg_timestamp  timestamptz not null,          -- when the message was sent
  body           text,                          -- extracted text (media captions incl.)
  processed_at   timestamptz,                   -- set once a memory note is written
  process_error  text,
  schema_version int not null default 1,
  created_at     timestamptz not null default now(),
  unique (user_email, wa_msg_id)
);
create index on whatsapp_message (user_email, card_id);
create index on whatsapp_message (user_email, chat_id);
-- The worker's delta query: "give me this user's not-yet-processed messages,
-- oldest first". A partial index on processed_at IS NULL keeps that scan cheap
-- even as the processed backlog grows.
create index whatsapp_message_unprocessed_idx
  on whatsapp_message (user_email, msg_timestamp)
  where processed_at is null;

alter table whatsapp_message enable row level security;
alter table whatsapp_message force row level security;

-- ----------------------------------------------------------------------------
-- 2. Generalize the memory tables for multiple sources.
--
--    memory_note was Gmail-only: message_id -> email_message(id) and a NOT NULL
--    gmail_msg_id. To carry WhatsApp notes we:
--      * drop the NOT NULL on gmail_msg_id (WhatsApp notes leave it null),
--      * add wa_message_id -> whatsapp_message(id) (null for email notes),
--      * add a generic source_ref text (the provider-native id, for display),
--    while keeping the existing email columns untouched so nothing breaks.
-- ----------------------------------------------------------------------------
alter table memory_note
  alter column gmail_msg_id drop not null;

alter table memory_note
  add column if not exists wa_message_id uuid references whatsapp_message(id) on delete cascade;

alter table memory_note
  add column if not exists source_ref text;      -- native id (gmail_msg_id or wa_msg_id)

create index if not exists memory_note_source_idx on memory_note (user_email, source);
create index if not exists memory_note_wa_idx on memory_note (user_email, wa_message_id);

-- note_chunk is already source-agnostic (it references memory_note and carries
-- user_email + card_id). Nothing to change there — WhatsApp chunks land in the
-- same table and the same ivfflat index, which is exactly what makes hybrid
-- retrieval span both channels with no RPC change.

-- ----------------------------------------------------------------------------
-- 3. sync_state: one row per (user_email, card_id). Add a channel discriminator
--    and WhatsApp-specific cursor columns. Gmail rows keep using
--    last_history_id / backfill_cursor; WhatsApp rows use wa_backfill_after
--    (the 1-month floor) and wa_last_processed_ts (the delta high-water mark).
-- ----------------------------------------------------------------------------
alter table sync_state
  add column if not exists channel text not null default 'gmail';   -- gmail | whatsapp

alter table sync_state
  add column if not exists wa_backfill_after timestamptz;            -- ingest floor (now - 1 month)

alter table sync_state
  add column if not exists wa_last_processed_ts timestamptz;         -- delta high-water mark

-- Existing Gmail rows are channel='gmail' by default; correct any that also
-- match a gmail card id, harmless if already right.
update sync_state set channel = 'gmail'
  where channel is null or channel = '';

-- ----------------------------------------------------------------------------
-- 4. Cross-channel graph edges.
--
--    entity_graph_nodes / entity_graph_edges (migration 0004) already unify
--    across sources because they key on user_email and entity_mention — a WA
--    note and an email note that both mention an entity co-occur through that
--    entity automatically. We ADD a per-node channel breakdown so the UI can
--    show WHICH channels an entity appears in (e.g. a small "email + whatsapp"
--    badge), without changing the existing node/edge RPCs.
-- ----------------------------------------------------------------------------
create or replace function entity_channels (p_user_email text)
returns table (
  entity_id  uuid,
  channels   text[]
)
language sql
stable
set search_path = public
as $$
  select em.entity_id,
         array_agg(distinct mn.source order by mn.source) as channels
  from entity_mention em
  join memory_note mn on mn.id = em.note_id and mn.user_email = em.user_email
  where em.user_email = p_user_email
  group by em.entity_id;
$$;

revoke all on function entity_channels(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Convenience RPC: per-user WhatsApp ingestion progress, for the UI card.
--    Mirrors the numbers a Gmail scan shows.
-- ----------------------------------------------------------------------------
create or replace function whatsapp_stats (p_user_email text)
returns table (
  total_messages     bigint,
  processed_messages bigint,
  chats              bigint,
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
    count(distinct chat_id)                             as chats,
    min(msg_timestamp)                                  as earliest,
    max(msg_timestamp)                                  as latest
  from whatsapp_message
  where user_email = p_user_email;
$$;

revoke all on function whatsapp_stats(text) from public, anon, authenticated;
