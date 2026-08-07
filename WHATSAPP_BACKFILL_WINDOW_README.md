# WhatsApp backfill window is now configurable

Previously WhatsApp always backfilled a fixed **30 days**, ignoring the
"Initial ingestion (one-time backfill)" field in the connector settings modal.
Now WhatsApp honors that field exactly like Gmail: saving **10** ingests the last
**10 days**.

## Where the window comes from

The single source of truth is `sync_state.wa_backfill_after` (the floor
timestamp). It is now derived from
`connector_state.settings.backfillDays` — the value the settings modal saves —
at every point that seeds it:

- **App connect** (`lib/whatsapp/service.ts` → `ensureSyncState`) reads the
  connector's `backfillDays` (default 30) and sets the floor to `now - days`.
- **Pairing worker** (`worker/src/pair-whatsapp.js` → `ensureSyncStateRow`) reads
  the same `connector_state.settings.backfillDays` from Supabase, so a link made
  through the dispatched `whatsapp-pair` workflow seeds the same window.
- **Saving settings before the first sync** (`PATCH /api/connectors/state`): if
  the user changes the field while WhatsApp's backfill hasn't completed yet
  (`sync_state.backfill_done` is not true), the new window is pushed straight onto
  `wa_backfill_after`, so the pending backfill honors it. Once backfill has
  completed, the floor is left alone — that history is already ingested, and
  widening it later is the heavier re-backfill path, not a settings toggle.

The capture and vectorize stages already read `wa_backfill_after` first, so no
change was needed there — the hardcoded 30-day values that remain are pure
fallbacks, only reached if the floor were ever null (it no longer is).

## Behavior

- Save **10** → next WhatsApp backfill pulls the last 10 days.
- Field range is 1–100 days (existing connector bounds; clamped client- and
  server-side). Fractional or ≤0 inputs are truncated/clamped to ≥1 day.
- Change the value **before** the first sync and it takes effect immediately.
  Change it **after** the initial backfill has completed and it applies to the
  next fresh link / re-backfill, not retroactively — existing notes are never
  deleted by a settings change.

## Files touched

- `lib/whatsapp/service.ts` — floor from `backfillDays` on connect.
- `worker/src/pair-whatsapp.js` — floor from `backfillDays` on pairing.
- `app/api/connectors/state/route.ts` — apply a new `backfillDays` to the pending
  WhatsApp floor on save.

No migration; no new workflow. `backfillDays` already existed in the settings
schema and modal.
