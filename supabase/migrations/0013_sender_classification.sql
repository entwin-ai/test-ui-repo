-- ============================================================================
-- Email sender classification (migration 0013).
--
-- Phase 1.2 of the build plan. Backs the "classify-type" step from the Email
-- Ingestion Read Me: classification is a persisted per-sender LIST MEMBERSHIP
-- lookup — one sender belongs to exactly one of Marketing / Updates / People,
-- decided once and reused for every email from that sender — NOT a set of
-- overlapping header/filter checks run per message.
--
-- PURELY ADDITIVE: a new table only. The current code path (worker's
-- classify.js) is rewritten to read this in Phase 3; nothing here changes
-- existing behavior on its own. Keyed by user_email; RLS enabled + FORCED with
-- no policies (service-layer isolation), matching the rest of the schema.
--
-- Implements, from "Email Ingestion Rules: Read Me":
--   §Classify        one sender -> one of three lists, decided once, reused
--   §Granularity     keyed to the EXACT sender address, never the parent domain
--   §Dual class.     optional entity tag per sender (pre-seeds the alias index)
--   §Onboarding      provisional (unconfirmed) placement via bootstrap heuristic,
--                    confirmed on the Kanban board; new senders land provisional
-- ============================================================================

create table if not exists sender_classification (
  id             uuid primary key default uuid_generate_v4(),
  user_email     text not null,                 -- isolation key (session email)

  -- EXACT sender address, lowercased, never the parent domain. A single org can
  -- span all three lists at once (marketing@bank, alerts@bank, an RM's own
  -- address), so the address — not the domain — is the classification key.
  sender_address text not null,

  -- Which of the three maintained lists this sender belongs to.
  list           text not null
                 check (list in ('marketing', 'updates', 'people')),

  -- Confirmed vs provisional. A sender first seen (at onboarding or later) is
  -- placed provisionally by the bootstrap heuristic and surfaced on the Kanban
  -- for the user to confirm/correct. false = still needs confirmation (the
  -- highlighted cards); true = settled.
  confirmed      boolean not null default false,

  -- How this row's list value was decided, for auditability and for the
  -- Kanban's "new sender" highlighting logic.
  --   bootstrap  -> placed by the first-seen heuristic (List-Unsubscribe /
  --                 domain-pattern guess), provisional
  --   manual     -> user set/moved it on the Kanban (implies confirmed)
  source         text not null default 'bootstrap'
                 check (source in ('bootstrap', 'manual')),

  -- Dual classification: the optional entity this sender maps to. Assigning it
  -- pre-seeds that entity's alias index (done in Phase 3). Blank is normal and
  -- expected for Marketing/Updates senders (tiers 1 and 2 never run entity
  -- extraction). A tag here is a dashboard-filter label and NEVER inflates
  -- bubble size. ON DELETE SET NULL so removing an entity just clears the tag.
  entity_id      uuid references entity(id) on delete set null,

  -- The bootstrap reason code (e.g. 'unsubscribe-header', 'domain-pattern'),
  -- kept so the Kanban can explain a provisional placement.
  bootstrap_reason text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One classification per sender address per user — the "decided once, reused"
  -- guarantee. Address is stored already-lowercased by the service layer.
  unique (user_email, sender_address)
);

create index if not exists sender_classification_user_idx
  on sender_classification (user_email);
-- The Kanban groups by list and highlights unconfirmed cards; index both.
create index if not exists sender_classification_list_idx
  on sender_classification (user_email, list);
create index if not exists sender_classification_unconfirmed_idx
  on sender_classification (user_email) where not confirmed;

-- Keep updated_at honest on every reclassification / confirm.
create or replace function sender_classification_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sender_classification_touch on sender_classification;
create trigger sender_classification_touch
  before update on sender_classification
  for each row
  execute function sender_classification_touch_updated_at();

alter table sender_classification enable row level security;
alter table sender_classification force row level security;
