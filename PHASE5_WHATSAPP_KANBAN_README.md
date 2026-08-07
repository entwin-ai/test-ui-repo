# Phase 5 — WhatsApp Kanban + manual moves & backfill

Phase 5 makes the classification from Phase 2 visible and editable: a two-column
WhatsApp Kanban (Read Me §7), the drag-to-move interaction, and the heavy
Updates→Important backfill that re-expands past gist days into full facet notes
(Read Me §8). It spans frontend (a new dashboard panel), API (a new route), and
worker (a new dispatched job).

## Two columns, not three (Read Me §7)

The board shows **Updates** and **Important WhatsApp Entities**. There is no third
column: archived entities are the Ignore tier and never appear — they're filtered
out server-side. Because community-subgroup volume can be large, the board has a
**search field** and each column **scrolls**, unlike the shorter drag-only email
board. Each card shows the entity's type and its live metadata — admin, muted,
member count, community — the facts Phase 1 captured.

## What was added

**API — `app/api/whatsapp/entities/route.ts`:**
- `GET` — joins `whatsapp_entity` (metadata + archived) with
  `whatsapp_classification` (tier/confirmed/reason) on `identity_key`, filters
  out archived, and returns the two columns with per-card metadata.
- `PATCH` — `{ identityKey, tier }` moves an entity (flips it to
  `source='manual'`, `confirmed=true`); `{ confirmed }` confirms a provisional
  bootstrap; `{ confirmAll:true }` confirms all. It upserts, so a
  freshly-seen entity can be moved before its bootstrap row exists. An
  **Updates→Important** move additionally dispatches the backfill workflow.

**Worker — `reprocessEntityAsImportant` in `whatsapp.js` + `whatsapp-move-backfill` MODE:**
- Loads the entity's whole captured history, **deletes its existing WhatsApp
  notes and their chunks**, **strips its gist lines from the affected days'
  `wa_updates` rollups** (leaving other entities' gists intact), then re-runs the
  full facet-split path (forced Important) over every day. Idempotent — re-running
  yields the same end state.

**Workflow — `.github/workflows/whatsapp-move-backfill.yml`:**
- Manual/dispatched job scoped to one `user_email` + `identity_key`, run out of
  band because it can be heavy at community scale (a stale subgroup carrying
  months of daily gists). Concurrency-guarded so it never overlaps a sync or a
  second backfill for the same entity.

**Frontend — `WhatsAppKanbanPanel` in `app/page.tsx` + CSS in `globals.css`:**
- A new "WhatsApp Kanban" subtab with the two-column board, search, scrollable
  columns, per-card metadata tags, provisional-highlight banner + confirm-all,
  and the move-effect note shown on drag.

## The two moves (Read Me §8)

- **Updates → Important** (forward): optimistic UI move + `PATCH`, which
  dispatches `whatsapp-move-backfill`. The job re-expands every past day the
  entity spent in Updates into full facet notes, dated to each day's original
  messages, and removes the now-superseded gist lines.
- **Important → Updates** (backward): **no deletion, no backfill.** Existing
  Memory Notes stand untouched; only new days log as gist, which the normal delta
  pipeline already does once the classification says `updates`. The UI shows this
  in the move note.

## Verify

- Worker files pass `node --check`; the new API route and panel are type-clean
  (the only `tsc` errors in this environment are the repo-wide missing-
  `node_modules` ones — `next/server`, `react`, `JSX.IntrinsicElements` — which
  affect every existing route/page equally).
- The move-backfill was validated end-to-end against a stubbed DB: moving a
  two-day Updates group re-expanded both days into facet notes, deleted the old
  note + chunks, and stripped exactly that entity's gist from both days' rollups
  while leaving another group's gist in place.

Deploy: no new migration (reuses Phase 1/2 tables + the `daily_rollup` from
0001). Deploy the app (new route + panel) and the worker (new MODE), and register
the new workflow. The Kanban populates from `whatsapp_classification` /
`whatsapp_entity`, so it needs at least one post–Phase-2 sync to have run.

## What remains

- **Phase 6** — the WhatsApp resolver ordering for changed numbers (username
  auto-merge vs. fuzzy `pending_review`), independent of this phase.
- **Unarchiving backfill** (Read Me open item / Phase 0 decision D4) is
  deliberately not built here; the recommended default is "permanent gap, no
  auto-backfill," with a manual re-expansion available via the same move-backfill
  path if ever wanted.
