# Phase 1 — schema foundation (migrations 0012 & 0013)

Phase 1 of the merged v5-schema + email-ingestion build plan. Two additive
migrations that lay the tables/columns every later phase reads. **No behavior
changes** — the Resolver, dashboards, and jobs that consume these land in
Phases 2–5. Both were validated end-to-end against a local Postgres 16
(applied, re-applied for idempotency, and functionally exercised).

## 0012 — entity lineage, matched_alias & note ownership

Implements, from *The Anatomy of a Memory Note v5*:

- **§7 `matched_alias`** — new nullable column on `entity_mention`, so each
  Memory Note Reference records which alias justified it (needed so a later
  split can partition references by alias). The `(user_email, entity_id,
  note_id)` uniqueness is unchanged.
- **§4 three-band alias matching** — new columns on `entity`:
  `pending_review` (bool, default false), `merge_candidate` (uuid → entity),
  `merge_score` (double). An ambiguous match creates a provisional entity
  flagged for human review; ingestion is never blocked. Partial index
  `entity_pending_review_idx` keeps the dashboard's "show pending" scan cheap.
- **§4 merge/split lineage** — `merged_into` (set when a merge retires this
  entity) and `split_from` (set on a new entity carved out by a split). All
  three lineage pointers are self-referential FKs with `on delete set null`.
- **§7 ownership index** — new `note_ownership` table answering "who currently
  owns this note" in one lookup. Keyed `(user_email, note_id,
  resolved_entity_id)`; carries `current_entity_id` (redirected by merge/split)
  and `matched_alias`. When `resolved_entity_id <> current_entity_id`, that is
  the visible trace of a later split/merge — the two-field note display in §7
  ("resolved at ingestion" vs "current entity") reads exactly this.

## 0013 — email sender classification

Implements, from *Email Ingestion Rules: Read Me*:

- New `sender_classification` table backing the classify-type step as a
  **persisted per-sender list lookup** (Marketing / Updates / People), decided
  once and reused — not overlapping header filters per message.
- **Exact-address keyed** (`unique (user_email, sender_address)`), never the
  parent domain, so one org can span all three lists.
- **Provisional vs confirmed** (`confirmed` bool, `source` bootstrap|manual,
  `bootstrap_reason`) for the onboarding Kanban's new-sender highlighting.
- **Dual classification** — optional `entity_id` tag per sender (pre-seeds the
  alias index in Phase 3); blank is normal for Marketing/Updates.
- `list` and `source` are CHECK-constrained; an `updated_at` trigger tracks
  reclassification.

## Isolation

Both new tables follow the established posture: RLS **enabled + forced with no
policies**, so only the `service_role` key (server routes + worker) can touch
them, always scoped by the session email. Same as 0002/0004/0010.

## Deployment

Apply both to Supabase, in order, before Phase 2 ships:

```
supabase db push        # or run 0012_… then 0013_… in the SQL editor
```

No new env vars or secrets. Purely additive — existing rows stay valid, and
re-running either migration is safe (idempotent).
```
```
