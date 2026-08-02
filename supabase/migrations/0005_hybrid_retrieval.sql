-- ============================================================================
-- Hybrid retrieval (migration 0005). Pure vector search misses exact keywords
-- (e.g. "RSVP") and has no notion of recency. This RPC blends three signals:
--   * vector similarity (semantic)
--   * full-text keyword match on the chunk content (exact terms)
--   * an optional recency boost (for "latest/recent/last" questions)
-- and returns the top match_count. User-scoped hard filter, as before.
--
-- Adds a GIN full-text index on note_chunk.content for the keyword side.
-- ============================================================================

-- Full-text index for the keyword arm (English config; fine for mixed content).
create index if not exists note_chunk_content_fts
  on note_chunk using gin (to_tsvector('english', content));

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
  score        float
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
      -- semantic: cosine similarity in [0,1]
      (1 - (c.embedding <=> query_embedding)) as vec_sim,
      -- keyword: ts_rank_cd of the chunk against the plain query (0 when no match)
      coalesce(
        ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', p_query_text)
        ),
        0
      ) as kw_rank,
      -- recency: 0..1 where 1 = newest, decaying over ~2 years
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
    -- weighted blend. keyword normalized (ts_rank_cd is unbounded-ish) by a
    -- simple scale; vector dominates, keyword rescues exact terms, recency is a
    -- tie-breaker that only kicks in when p_recency_boost is set.
    (
      0.6 * vec_sim
      + 0.3 * least(kw_rank * 4.0, 1.0)
      + (case when p_recency_boost then 0.25 else 0.05 end) * recency
    ) as score
  from base
  order by score desc
  limit match_count;
$$;

revoke all on function match_note_chunks_hybrid(text, vector, text, int, text, boolean)
  from public, anon, authenticated;
