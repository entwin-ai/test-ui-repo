-- ============================================================================
-- Date-range filtering for hybrid retrieval (migration 0026).
--
-- Vector + keyword search has no notion of an explicit date bound, so a query
-- like "outstanding tasks since 1st August" previously retrieved (and answered
-- from) notes dated before August. Prompt-only date instructions are
-- unreliable: the model only sees the top-K retrieved rows and does fuzzy
-- string date comparison. The correct place to enforce a window is here, in
-- SQL, where the filter is exact and out-of-window notes never enter the
-- context at all.
--
-- This supersedes the 0025 definition of match_note_chunks_hybrid, adding two
-- nullable params:
--   p_date_from  — inclusive lower bound on note_date (null = open-ended)
--   p_date_to    — inclusive upper bound on note_date (null = open-ended)
-- When both are null the behaviour is identical to 0025. The RETURNS TABLE is
-- unchanged, so existing callers/columns are unaffected.
--
-- NOTE: this is a NEW overload (extra args have defaults), but because the
-- previous 6-arg version still exists, we DROP it first to avoid an ambiguous
-- overload set when callers pass positional/named args.
-- ============================================================================

drop function if exists match_note_chunks_hybrid(text, vector, text, int, text, boolean);

create or replace function match_note_chunks_hybrid (
  p_user_email    text,
  query_embedding vector(1536),
  p_query_text    text,
  match_count     int default 12,
  p_card_id       text default null,
  p_recency_boost boolean default false,
  p_date_from     date default null,
  p_date_to       date default null
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
      -- Hard date window. Nulls disable the respective bound, so an unbounded
      -- query is unaffected. Out-of-window notes are excluded before ranking,
      -- so they can never crowd out in-window matches in the top-N.
      and (p_date_from is null or m.note_date >= p_date_from)
      and (p_date_to   is null or m.note_date <= p_date_to)
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

revoke all on function match_note_chunks_hybrid(text, vector, text, int, text, boolean, date, date)
  from public, anon, authenticated;
