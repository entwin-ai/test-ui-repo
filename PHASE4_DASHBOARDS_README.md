# Phase 4 — Entity Review & Sender Kanban dashboards

Phase 4 of the merged build plan: the two human-facing dashboards over the
Phase 2 engine and Phase 3 sender table, plus the two-entity note display. The
dashboard UI already existed as static panels (`KanbanPanel`, `EntitiesPanel`);
this phase wires them to real backend routes and adds the New Review and split
flows. Verified: app typechecks + builds, all routes registered, and the route
queries checked against local Postgres.

## New API routes (thin, session-scoped, call Phase 2 operations)

- `GET  /api/entities/review` — pending_review entities, each enriched with its
  merge_candidate's name, score, alias list, and reference count.
- `POST /api/entities/merge`  `{sourceId,targetId}` — merge (Pending "accept" &
  New Review manual merge).
- `POST /api/entities/reject` `{entityId}` — clear a provisional flag (Pending
  "keep as distinct").
- `POST /api/entities/split`  `{fromId,aliases[],newName?}` — split aliases into
  a new entity.
- `GET  /api/entities/search?q=` / `?id=` — search entities (New Review) / fetch
  one entity's aliases (split UI).
- `GET  /api/senders` / `PATCH /api/senders` — Kanban read; move (`{id,list}`,
  auto-confirms), confirm one (`{id,confirmed}`), tag entity (`{id,entityId}`),
  or `{confirmAll:true}`.
- `GET  /api/notes/[id]/entities` — the two-field note display data (v5 §7):
  resolved-at-ingestion vs current entity, with a `diverged` flag.

## Frontend (app/page.tsx)

- **Entity Review (`EntitiesPanel`)** — now data-driven:
  - *Pending Review*: real cards from `/api/entities/review`; "Merge into
    <candidate>" and "Keep as distinct" call the live routes and drop the card.
  - *New Review* (`NewReviewPanel`, new): debounced entity search; select an
    entity to (a) merge it into another, or (b) check specific aliases and split
    them into a new entity.
  - Subtab badge reflects the real pending count.
- **Sender Kanban (`KanbanPanel`)** — now data-driven: loads `/api/senders`,
  three columns, unconfirmed senders highlighted as "New", drag-to-reclassify
  (persists + confirms via PATCH), and "Confirm classification" (confirmAll).
- **`NoteEntities`** — reusable component rendering resolved-vs-current for a
  note (amber when diverged). Backend + component + CSS are ready; it mounts
  wherever a Memory-Note viewer is built (that surface is an open item in the
  spec, so nothing renders it yet).

## Verified behavior

- Review query returns candidate name + score + reference count for a pending
  entity.
- `confirmAll` flips only unconfirmed senders (confirmed ones untouched).
- Note-entities agree case reports `diverged=false`; Phase 2 already proved the
  diverged case after a merge/split.
- Merge/reject/split operations were validated end-to-end in Phase 2.

## Notes / scope

- **No Memory Note is ever rewritten** by any dashboard action — only entity
  files, mentions, and the ownership index (inherited from Phase 2 operations).
- **The note-viewer surface itself is not built here.** The two-field display is
  a ready component + route; the spec lists "where a Memory-viewing tool lives"
  as an open item, so Phase 4 stops at making the capability available, not
  inventing that screen.
- **Onboarding calibration (90-day → confirm → full ingest) is Phase 5.** The
  Kanban here confirms senders; the first-connection flow that gates full
  ingestion on that confirmation is the next phase.

## Deployment

Requires Phase 1 migrations (0012/0013). No new migration, env var, or secret —
deploy the updated app. Nothing in Redis/Upstash.
