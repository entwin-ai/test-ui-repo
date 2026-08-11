-- ============================================================================
-- Return source + FK back-pointers from the match RPCs (migration 0025).
--
-- The RAG layer (lib/rag/query.ts) labels each retrieved chunk by channel and,
-- as of the hydration work, needs the note's `source` to group matches for
-- raw-source hydration. Previously match_note_chunks_hybrid and
-- match_entity_chunks did NOT return `source`, so query.ts read m.source as
-- undefined and every block silently fell back to the 'email' label. This
-- migration re-defines both RPCs to also return `source`. Hydration itself
-- re-fetches the FK columns from memory_note under a user_email scope (see
-- lib/rag/hydrate.ts), so we only need `source` here for correct labeling and
-- per-source grouping.
--
-- Signatures (arguments) are unchanged; only the RETURNS TABLE gains a column,
-- appended at the END so positional callers are unaffected.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Hybrid retrieval (supersedes the 0005 definition).
-- ----------------------------------------------------------------------------
create or replace function match_note_chunks_hybrid (
  p_user_email    text,
  query_embedding vector(1536),
  p_query_text    text,
  match_count     int default 12,
  p_card_id       text default null,
  p_recency_boost boolean default false
)
returns table (
  chunk_id     uuid,
  note_id      uuid,
  content      text,
  gmail_msg_id text,
  source_url   text,
  note_date    date,
  urgency      text,
  score        float,
  source       text
)
language sql
stable
set search_path = public, extensions
as $$
  with base as (
    select
      c.id as chunk_id,
      c.note_id,
      c.content,
      m.gmail_msg_id,
      m.source_url,
      m.note_date,
      m.urgency,
      m.source,
      (1 - (c.embedding <=> query_embedding)) as vec_sim,
      coalesce(
        ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', p_query_text)
        ),
        0
      ) as kw_rank,
      greatest(
        0,
        1 - (extract(epoch from (now() - m.note_date::timestamp)) / (2 * 365 * 24 * 3600))
      ) as recency
    from note_chunk c
    join memory_note m on m.id = c.note_id
    where c.user_email = p_user_email
      and (p_card_id is null or c.card_id = p_card_id)
  )
  select
    chunk_id, note_id, content, gmail_msg_id, source_url, note_date, urgency,
    (
      0.6 * vec_sim
      + 0.3 * least(kw_rank * 4.0, 1.0)
      + (case when p_recency_boost then 0.25 else 0.05 end) * recency
    ) as score,
    source
  from base
  order by score desc
  limit match_count;
$$;

revoke all on function match_note_chunks_hybrid(text, vector, text, int, text, boolean)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Entity retrieval (supersedes the 0004 definition).
-- ----------------------------------------------------------------------------
create or replace function match_entity_chunks (
  p_user_email    text,
  p_entity_id     uuid,
  query_embedding vector(1536),
  match_count     int default 12
)
returns table (
  chunk_id     uuid,
  note_id      uuid,
  content      text,
  gmail_msg_id text,
  source_url   text,
  note_date    date,
  urgency      text,
  similarity   float,
  source       text
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.id, c.note_id, c.content, m.gmail_msg_id, m.source_url, m.note_date, m.urgency,
    1 - (c.embedding <=> query_embedding) as similarity,
    m.source
  from note_chunk c
  join memory_note m on m.id = c.note_id
  join entity_mention em on em.note_id = m.id and em.user_email = c.user_email
  where c.user_email = p_user_email
    and em.entity_id = p_entity_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function match_entity_chunks(text, uuid, vector, int)
  from public, anon, authenticated;
