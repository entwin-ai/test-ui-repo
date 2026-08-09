-- ============================================================================
-- Chat history persistence (migration 0020).
--
-- Persists every turn of the assistant conversation exactly as it is rendered
-- on screen: the user's message and Entwin's reply, each with its role, the
-- verbatim text, any sources shown beneath an answer, whether it was an error
-- bubble, and the timestamp it was created. The "All chats" tab reads these
-- back chronologically (most recent first).
--
-- Same isolation model as the rest of the app: users are NOT Supabase
-- auth.users, so isolation is enforced in the SERVICE LAYER by scoping every
-- query on user_email (derived server-side from the NextAuth session, never
-- from client input). RLS is enabled + forced with no policies, so anon /
-- authenticated keys read nothing; only the service_role key (server routes)
-- can touch these rows, and those paths always add the email filter.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A chat session groups the turns of one conversation. A new session is minted
-- whenever the user starts a "New chat". The title is derived from the first
-- user message so the All chats list has something human to show.
-- ----------------------------------------------------------------------------
create table if not exists chat_session (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,                 -- isolation key (session email)
  client_id     text not null,                 -- id minted by the browser per conversation
  title         text,                          -- first user message, trimmed (nullable until first turn)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_email, client_id)
);
create index if not exists chat_session_user_updated_idx
  on chat_session (user_email, updated_at desc);

-- ----------------------------------------------------------------------------
-- One row per rendered message. `sources` stores the exact array shown under an
-- assistant answer (n / url / date / urgency / channel / similarity). `seq` is
-- a monotonic per-session ordinal so turns keep their on-screen order even when
-- two land in the same millisecond.
-- ----------------------------------------------------------------------------
create table if not exists chat_message (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,                 -- isolation key (session email)
  session_id    uuid not null references chat_session(id) on delete cascade,
  client_id     text not null,                 -- denormalised conversation id (matches chat_session.client_id)
  role          text not null,                 -- 'user' | 'assistant'
  text          text not null,                 -- verbatim bubble text
  sources       jsonb not null default '[]',   -- AskSource[] shown under an answer
  is_error      boolean not null default false,-- true for the red error bubbles
  model         text,                          -- model label active when the turn was produced
  seq           int not null default 0,        -- per-session render order
  created_at    timestamptz not null default now(),
  unique (user_email, session_id, seq)
);
create index if not exists chat_message_user_created_idx
  on chat_message (user_email, created_at desc);
create index if not exists chat_message_session_seq_idx
  on chat_message (session_id, seq);

-- Same defense-in-depth RLS posture as migration 0002: enable + force, no
-- policies, so only the service_role key (server routes) can read/write.
alter table chat_session enable row level security;
alter table chat_message enable row level security;
alter table chat_session force row level security;
alter table chat_message force row level security;
