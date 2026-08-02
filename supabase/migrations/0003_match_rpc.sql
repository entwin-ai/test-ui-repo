-- ============================================================================
-- Retrieval RPC. Called only by server-side code with the service_role key,
-- which ALWAYS passes the session-derived p_user_email. The email filter is
-- applied INSIDE the ANN scan (pre-filter) so one heavy user cannot crowd
-- another out of the top-k.
--
-- SECURITY NOTE: because this runs under service_role, the p_user_email
-- argument is the isolation boundary. The Next route that calls it derives the
-- email from getServerSession — never from the request body.
-- ============================================================================

create or replace function match_note_chunks (
  p_user_email  text,
  query_embedding vector(1536),
  match_count   int default 8,
  p_card_id     text default null           -- optional: one Gmail card
)
returns table (
  chunk_id     uuid,
  note_id      uuid,
  content      text,
  gmail_msg_id text,
  source_url   text,
  note_date    date,
  urgency      text,
  similarity   float
)
language sql
stable
set search_path = public
as $$
  select
    c.id,
    c.note_id,
    c.content,
    m.gmail_msg_id,
    m.source_url,
    m.note_date,
    m.urgency,
    1 - (c.embedding <=> query_embedding) as similarity
  from note_chunk c
  join memory_note m on m.id = c.note_id
  where c.user_email = p_user_email            -- HARD user scope
    and (p_card_id is null or c.card_id = p_card_id)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Only reachable via service_role (which bypasses grants). Deny everyone else.
revoke all on function match_note_chunks(text, vector, int, text) from public, anon, authenticated;
