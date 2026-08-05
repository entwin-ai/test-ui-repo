# Per-user Gmail delta scheduling

Each user's Gmail delta (incremental sync) now runs at **their own chosen
cadence** — the "Reading frequency → Poll every N hours" they set in the Gmail
card's settings modal — instead of every account syncing on one global cron.

If user X sets Gmail Personal to **3 hours** and user Y sets theirs to **10
hours**, X's delta runs roughly once every 3 hours and Y's once every 10, off
the same schedule.

## How it works

There is one **heartbeat** cron plus **per-account gating** in the worker — no
external scheduler required.

1. **Heartbeat** — `.github/workflows/delta.yml` fires hourly (`0 * * * *`) in
   `MODE=delta`. (Hourly because 1 hour is the smallest selectable frequency.)
2. **Gating** — for each Gmail row in `sync_state`, the worker reads that user's
   `pollHours` from `connector_state.settings` (keyed by
   `user_email` + `connector_key = card_id`) and compares `now()` against
   `sync_state.last_delta_at + pollHours`. If not enough time has passed, the
   account is skipped this tick; otherwise delta runs and `last_delta_at` is
   stamped to `now()`.

The frequency has a **single source of truth**: the value the settings modal
already writes to `connector_state.settings.pollHours`. Change it in the UI and
the next heartbeat picks it up automatically — nothing else to update. Values
are clamped to the same 1–24h bounds the UI enforces; an account with no saved
settings falls back to a 24h default.

## Files changed

- `supabase/migrations/0011_delta_schedule.sql` — adds `last_delta_at` (+ index)
  to `sync_state`.
- `worker/src/lib/schedule.js` — reads per-user `pollHours` and decides whether
  an account is due; stamps `last_delta_at`.
- `worker/src/index.js` — gates the Gmail delta loop with `deltaDue()` and
  records `last_delta_at` on a successful delta.
- `.github/workflows/delta.yml` — heartbeat changed from every 15 min to hourly,
  with the per-user logic documented.

## Deployment

1. Apply the migration to Supabase:
   ```
   supabase db push        # or run supabase/migrations/0011_delta_schedule.sql
   ```
2. Deploy the updated `worker/` and `.github/workflows/delta.yml` (commit +
   push; GitHub Actions picks up the new schedule).

No new environment variables or secrets. Existing accounts have
`last_delta_at = NULL`, so each is treated as "due" on the first tick after
deploy, then settles into its user's cadence.

## Notes / trade-offs

- GitHub cron is best-effort and can be delayed or skipped under load, and it
  auto-disables after 60 days of repo inactivity. For tighter guarantees, drive
  `workflow_dispatch` from Supabase `pg_cron`, Trigger.dev, or QStash on the same
  hourly (or finer) beat — the worker's gating logic is unchanged.
- To later allow sub-hourly frequencies, lower the cron (e.g. `*/30 * * * *` or
  `*/15 * * * *`) and widen the clamp in `worker/src/lib/schedule.js` and
  `lib/connectors/state.ts` to match.
- `workflow_dispatch` still runs an immediate pass; due-gating still applies, so
  a manual run only syncs accounts that are actually due. Temporarily bypass by
  running with accounts whose `last_delta_at` you've cleared, if you need a
  forced full pass.
