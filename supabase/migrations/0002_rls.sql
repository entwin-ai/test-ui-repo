-- ============================================================================
-- RLS posture for the NextAuth (email-keyed) model.
--
-- Because app users are NOT Supabase auth.users, there is no auth.uid() to
-- filter on. The real isolation boundary is the SERVICE LAYER (lib/rag/*),
-- which scopes every query by the server-derived session email.
--
-- Defense in depth here: enable + FORCE RLS with NO policies for anon /
-- authenticated. That means the anon and authenticated keys can read NOTHING,
-- so even if the anon key leaked to a browser it exposes zero rows. Only the
-- service_role key (used exclusively by the worker and by server-side Next
-- route handlers) bypasses RLS — and those paths always add the email filter.
--
-- If you later migrate to Supabase Auth, add auth.uid()-based policies and set
-- user_email from auth.jwt() ->> 'email'.
-- ============================================================================

alter table email_message enable row level security;
alter table memory_note   enable row level security;
alter table note_chunk    enable row level security;
alter table daily_rollup  enable row level security;
alter table sync_state    enable row level security;
alter table llm_cost_log  enable row level security;

alter table email_message force row level security;
alter table memory_note   force row level security;
alter table note_chunk    force row level security;
alter table daily_rollup  force row level security;
alter table sync_state    force row level security;
alter table llm_cost_log  force row level security;

-- No policies created => anon & authenticated see zero rows on every table.
-- service_role bypasses RLS and is the only credential the server uses.
