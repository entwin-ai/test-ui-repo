# Tier 1 — Chat truthfulness, real Dashboard metrics, rolling ingestion window

Built on Tier 0 (validated LLM keys + working providers). Three gaps closed.

## 1. Chat header is now truthful

`app/page.tsx` — the Chat sub-header was hardcoded to "Local placeholder — no
model connected yet" regardless of state. It now reflects the real
`llmConfigured` / `currentModel` values already loaded in `AppShell`:

- loading → "Checking model…"
- configured → "Answering from your vault · <model>"
- not configured → "No model connected — set an API key in Settings"

No new state; it reuses the label the top-right status already derives.

## 2. Dashboard metrics are real (no more hardcoded numbers)

`app/api/usage/route.ts` was extended (same endpoint the Dashboard already
polls every 15s) to return real, session-scoped counts alongside token usage:

- `notesIndexed` — `count(memory_note)` for the user (Memory Notes written).
- `preferencesLearned` — `count(entity)` (canonical people/orgs the twin knows —
  the personalization surface).
- `ingestion7d.{ignore,storage,memoryWorthy}` — last-7-day volume, summed from
  `daily_rollup` (`ignored`, and `updates`+`wa_updates`) and `memory_note`
  created in the window. Replaces the demo 184/42/67.
- `entitiesThisWeek` — entities created in the last 7 days.

Each count is a `head:true` count query (no rows shipped) and degrades to `null`
independently, so one failing count never blanks the whole dashboard.

Front-end (`OverviewPanel`) now renders these:
- "Notes indexed" and "Preferences learned" cards show the real values (or "—"
  while loading / on error); the "Placeholder — future …" sub-labels are gone.
- "Ingestion volume, last 7 days" tiers are wired to `ingestion7d`.
- "Entity growth" cards now show real derivable numbers (new-this-week, total
  entities, total notes) instead of invented 12/34/7 — the two figures that
  couldn't be derived accurately were replaced with ones that can, rather than
  left as fiction.

The `Usage` interface was widened to match.

## 3. Total ingestion window — editable AND enforced

Previously `totalWindowDays` was frozen at 365 in the modal AND unused by any
backend — a stored number with no effect. Making the stepper editable alone
would just move the honesty problem, so this makes the window *do* something:

**UI** (`app/page.tsx`): the "Total ingestion window" stepper is now editable
(30–3650 days), floored at the current backfill size; raising the backfill above
the window pulls the window up with it. It already saved via the existing
`handleSaveSettings`.

**Validation** (`lib/connectors/state.ts`): server-side bounds widened to
30–3650; `sanitizeSettings` now floors `totalWindowDays` at `backfillDays` so a
hand-crafted POST can't index less than it backfilled.

**Enforcement** (worker): the window now drives real rolling retention.
- `worker/src/lib/schedule.js` — new `windowDaysFor(user, card)` reader,
  mirroring the app bounds and re-flooring at the backfill defensively.
- `worker/src/lib/prune.js` (new) — `pruneToWindow(user, card)` deletes
  `memory_note` older than the window (`note_chunk` cascades via FK) and stale
  `daily_rollup` rows. Raw source messages are left intact so widening the
  window later can re-derive notes without a re-fetch. Best-effort and isolated:
  a prune failure is logged and swallowed, never failing a run.
- `worker/src/index.js` — calls `pruneToWindow` after each recurring `delta`
  pass (never on backfill/calibrate), so retention tracks the user's setting.

## Files touched / added

- `app/page.tsx` — chat header, Dashboard metric wiring, editable window stepper
- `app/api/usage/route.ts` — real ingestion metrics
- `lib/connectors/state.ts` — window bounds + backfill floor
- `worker/src/lib/schedule.js` — `windowDaysFor`
- **added** `worker/src/lib/prune.js` — rolling-window retention
- `worker/src/index.js` — prune after delta
- **added** `TIER1_METRICS_AND_WINDOW_README.md`

Verified: `tsc --noEmit` clean, `next build` compiled successfully, `node
--check` on all changed/added worker files.

## Note

No new migration is required — every metric reads existing tables, and the prune
uses existing columns and FK cascades. `notesIndexed` / `ingestion7d` / etc. read
0 (not a placeholder) until ingestion writes rows; that is now an accurate
reflection of an empty vault rather than a hardcoded stand-in.
