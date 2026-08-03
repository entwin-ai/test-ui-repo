-- ============================================================================
-- Add channel/source to hybrid + entity retrieval (migration 0007).
--
-- With WhatsApp notes now in note_chunk, RAG already retrieves across both
-- channels (match_note_chunks_hybrid keys only on user_email). This migration
-- surfaces WHICH channel each retrieved chunk came from, so the /api/ask
-- answer and source chips can say "from WhatsApp" vs "from email". Purely
-- additive: adds a `source` column to the returned rows; the blend/order is
-- unchanged.
-- ============================================================================

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
  source       text,
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
      m.source,
      m.source_url,
      m.note_date,
      m.urgency,
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
    chunk_id, note_id, content, gmail_msg_id, source, source_url, note_date, urgency,
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

-- Same treatment for the entity-scoped retrieval used by the wiki/"what do I
-- know about X" path, so an entity's answer can cite email + WhatsApp sources.
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
  source       text,
  source_url   text,
  note_date    date,
  urgency      text,
  similarity   float
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.id, c.note_id, c.content, m.gmail_msg_id, m.source, m.source_url, m.note_date, m.urgency,
    1 - (c.embedding <=> query_embedding) as similarity
  from note_chunk c
  join memory_note m on m.id = c.note_id
  join entity_mention em on em.note_id = m.id and em.user_email = c.user_email
  where c.user_email = p_user_email
    and em.entity_id = p_entity_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function match_entity_chunks(text, uuid, vector, int) from public, anon, authenticated;
