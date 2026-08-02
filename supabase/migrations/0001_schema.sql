-- ============================================================================
-- Entwin standard-RAG schema — keyed by (user_email, card_id).
-- This app authenticates with NextAuth (Google); users are NOT in Supabase
-- auth.users, so isolation is enforced in the SERVICE LAYER: every query is
-- scoped by the session email, which is always derived server-side from the
-- NextAuth session and NEVER accepted from client input.
--
-- card_id is one of: gmail-personal | gmail-professional (matches the frontend).
-- Design records: Memory Notes v4 + Email Ingestion ReadMe v1.
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ----------------------------------------------------------------------------
-- Raw message ledger — idempotency + dedup + resumability.
-- ----------------------------------------------------------------------------
create table if not exists email_message (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,                 -- isolation key (session email)
  card_id       text not null,                 -- gmail-personal | gmail-professional
  gmail_msg_id  text not null,
  thread_id     text not null,
  internal_date timestamptz not null,
  sender        text,
  recipients    text[],
  subject       text,
  labels        text[],
  tier          text not null,                 -- ignore | storage | memory
  tier_reason   text,
  clean_body    text,
  content_hash  text,
  processed_at  timestamptz,
  process_error text,
  schema_version int not null default 1,
  created_at    timestamptz not null default now(),
  unique (user_email, gmail_msg_id)
);
create index on email_message (user_email, card_id);
create index on email_message (user_email, thread_id);
create index on email_message (user_email, tier);

-- ----------------------------------------------------------------------------
-- Memory Note — atomic unit (tier-3). Immutable after write. (v4 §3 anatomy.)
-- ----------------------------------------------------------------------------
create table if not exists memory_note (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,
  card_id       text not null,
  note_id       text not null,                 -- date-source-sequence, once
  message_id    uuid references email_message(id) on delete cascade,
  gmail_msg_id  text not null,
  source        text not null default 'email',
  note_date     date not null,
  name          text,
  raw_summary   text not null,
  urgency       text not null,                 -- critical|high|medium|low
  life_domain   text not null,                 -- personal|professional
  action        text[] not null,               -- respond|give|schedule|decision|await|none|blank
  free_text     text,
  confidentiality text,                        -- yes|no|blank
  related_entities text[] not null default '{}',
  action_edges  uuid[] not null default '{}',
  source_url    text,
  schema_version int not null default 1,
  created_at    timestamptz not null default now(),
  unique (user_email, note_id)
);
create index on memory_note (user_email, card_id);
create index on memory_note (user_email, note_date);

-- ----------------------------------------------------------------------------
-- Vector chunks — OpenAI text-embedding-3-small (1536 dims).
-- ----------------------------------------------------------------------------
create table if not exists note_chunk (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,
  card_id       text not null,
  note_id       uuid not null references memory_note(id) on delete cascade,
  chunk_index   int  not null default 0,
  content       text not null,
  embedding     vector(1536),
  embed_model   text not null default 'text-embedding-3-small',
  created_at    timestamptz not null default now()
);
create index on note_chunk (user_email, card_id);
create index note_chunk_embedding_idx on note_chunk
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ----------------------------------------------------------------------------
-- Daily rollups — tier-1 (ignored) + tier-2 (updates). Append-only.
-- ----------------------------------------------------------------------------
create table if not exists daily_rollup (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,
  card_id       text not null,
  rollup_date   date not null,
  kind          text not null,                 -- ignored | updates
  entries       jsonb not null default '[]',
  entry_count   int  not null default 0,
  updated_at    timestamptz not null default now(),
  unique (user_email, card_id, rollup_date, kind)
);
create index on daily_rollup (user_email, rollup_date);

-- ----------------------------------------------------------------------------
-- Per-account sync cursors (backfill checkpoint + delta historyId).
-- One row per (user_email, card_id).
-- ----------------------------------------------------------------------------
create table if not exists sync_state (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,
  card_id       text not null,
  last_history_id text,
  backfill_cursor text,
  backfill_done boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (user_email, card_id)
);
create index on sync_state (user_email);

-- ----------------------------------------------------------------------------
-- Per-LLM-call cost ledger (v4: one row per LLM call).
-- ----------------------------------------------------------------------------
create table if not exists llm_cost_log (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,
  call_kind     text not null,                 -- write_note|extract_entities|updates_summary
  model         text not null,
  input_tokens  int,
  output_tokens int,
  created_at    timestamptz not null default now()
);
create index on llm_cost_log (user_email, created_at);
