-- ============================================================================
-- Wiki RAG + relationship graph — entity layer (migration 0004).
--
-- Reuses existing data: memory_note.related_entities is the raw material. This
-- migration adds only the IDENTITY layer the Resolver produces (canonical
-- entities + alias matching) plus a join table mapping entities to the notes
-- that mention them. No email content is duplicated. Keyed by user_email like
-- everything else, isolated in the service layer.
-- ============================================================================

-- One row per resolved person/organisation the system knows about.
-- (v4 §4 Entity file frontmatter, as a row.)
create table if not exists entity (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,
  canonical_name text not null,          -- the display name
  norm_name      text not null,          -- lowercased/normalized key for matching
  entity_type    text,                   -- person | organisation | unknown
  aliases        text[] not null default '{}',
  first_seen     date,
  last_seen      date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- one canonical entity per normalized name per user (the alias-match anchor)
  unique (user_email, norm_name)
);
create index on entity (user_email);

-- Memory Note References (v4 §4): which notes mention which entity. Append-only
-- in spirit; derived from related_entities. This is what drives bubble size.
create table if not exists entity_mention (
  id           uuid primary key default uuid_generate_v4(),
  user_email   text not null,
  entity_id    uuid not null references entity(id) on delete cascade,
  note_id      uuid not null references memory_note(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (user_email, entity_id, note_id)
);
create index on entity_mention (user_email);
create index on entity_mention (user_email, entity_id);
create index on entity_mention (user_email, note_id);

-- RLS: same posture as the rest — enabled + forced, no anon/authenticated
-- policies, service_role only (isolation enforced in the service layer).
alter table entity          enable row level security;
alter table entity_mention  enable row level security;
alter table entity          force row level security;
alter table entity_mention  force row level security;

-- ----------------------------------------------------------------------------
-- Graph RPC: nodes (entities + bubble size) and the data to build edges.
-- Bubble size = count of distinct notes mentioning the entity (v4: degree).
-- Returns one row per entity; the app builds co-occurrence edges from
-- entity_graph_edges below.
-- ----------------------------------------------------------------------------
create or replace function entity_graph_nodes (p_user_email text)
returns table (
  entity_id      uuid,
  canonical_name text,
  entity_type    text,
  bubble_size    bigint,
  first_seen     date,
  last_seen      date
)
language sql
stable
set search_path = public
as $$
  select
    e.id,
    e.canonical_name,
    e.entity_type,
    count(distinct m.note_id) as bubble_size,
    e.first_seen,
    e.last_seen
  from entity e
  left join entity_mention m
    on m.entity_id = e.id and m.user_email = e.user_email
  where e.user_email = p_user_email
  group by e.id, e.canonical_name, e.entity_type, e.first_seen, e.last_seen
  order by bubble_size desc;
$$;

-- Edges: two entities are linked when they co-occur in the same Memory Note.
-- Weight = number of shared notes. Undirected (a<b to avoid duplicate pairs).
create or replace function entity_graph_edges (p_user_email text)
returns table (
  source_id uuid,
  target_id uuid,
  weight    bigint
)
language sql
stable
set search_path = public
as $$
  select a.entity_id as source_id, b.entity_id as target_id, count(*) as weight
  from entity_mention a
  join entity_mention b
    on a.note_id = b.note_id
   and a.user_email = b.user_email
   and a.entity_id < b.entity_id
  where a.user_email = p_user_email
  group by a.entity_id, b.entity_id;
$$;

-- ----------------------------------------------------------------------------
-- Wiki retrieval: chunks for notes that mention a given entity, ranked by
-- similarity to a query embedding. This is the entity-scoped RAG ("what do I
-- know about X"). User-scoped hard filter, same as match_note_chunks.
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
  similarity   float
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.id, c.note_id, c.content, m.gmail_msg_id, m.source_url, m.note_date, m.urgency,
    1 - (c.embedding <=> query_embedding) as similarity
  from note_chunk c
  join memory_note m on m.id = c.note_id
  join entity_mention em on em.note_id = m.id and em.user_email = c.user_email
  where c.user_email = p_user_email
    and em.entity_id = p_entity_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function entity_graph_nodes(text) from public, anon, authenticated;
revoke all on function entity_graph_edges(text) from public, anon, authenticated;
revoke all on function match_entity_chunks(text, uuid, vector, int) from public, anon, authenticated;
