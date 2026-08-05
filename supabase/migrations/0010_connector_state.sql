-- ============================================================================
-- Per-user connector UI state (migration 0010).
--
-- Goal: persist, per user, two things that were previously local-only React
-- state and therefore lost on every reload / device switch:
--   1. The Connect / Disconnect toggle of EVERY connector card in the
--      Connectors tab (including cards with no real backend of their own —
--      Google Drive, Calendar, Browser history, Animatics — plus a mirror of
--      the cards that DO have a real backend so the grid can paint instantly).
--   2. The settings each connector card exposes in its gear/settings modal
--      (poll frequency, initial-ingestion backfill days, total window, …).
--      These are saved only when the user clicks "Save settings" for that box.
--
-- Keyed by (user_email, connector_key) like every other table in this schema.
-- connector_key is a stable slug the frontend assigns to each card, e.g.
--   gmail-personal | gmail-professional | drive-personal | drive-professional |
--   calendar | whatsapp | animatics | slack-workspace | browser-history
--
-- Isolation follows the same model as the rest of Entwin: app users are NOT in
-- Supabase auth.users, so RLS is enabled + FORCED with NO policies, and the
-- ONLY credential that touches this table is the service_role key used by the
-- server route handler, which always scopes by the server-derived session email
-- (never client input). See 0002_rls.sql.
-- ============================================================================

create table if not exists connector_state (
  id            uuid primary key default uuid_generate_v4(),
  user_email    text not null,                 -- isolation key (session email)
  connector_key text not null,                 -- stable per-card slug (see above)
  -- Persisted Connect/Disconnect toggle for this card. For cards backed by a
  -- real OAuth/token flow (Gmail, Slack, WhatsApp) this is a fast-paint mirror;
  -- the authoritative liveness still comes from the respective status endpoint,
  -- and the merge on the client prefers the backend truth when they disagree.
  connected     boolean not null default false,
  -- Per-card settings blob (poll hours, backfill days, total window, and any
  -- future per-connector knobs). Stored as jsonb so new fields need no schema
  -- change. Validated/clamped in the service layer before it lands here.
  settings      jsonb   not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_email, connector_key)
);

create index if not exists connector_state_user_idx
  on connector_state (user_email);

-- Keep updated_at honest on every upsert/update.
create or replace function connector_state_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists connector_state_touch on connector_state;
create trigger connector_state_touch
  before update on connector_state
  for each row
  execute function connector_state_touch_updated_at();

alter table connector_state enable row level security;
alter table connector_state force row level security;
-- No policies => anon & authenticated read nothing; service_role bypasses RLS
-- and is the only credential the server uses (always email-scoped).
