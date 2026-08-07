# Phase 5 — Onboarding, sender-move backfill & trash reconciliation

Phase 5 of the merged build plan: the three scheduled / flow-integrated jobs
from the Email Ingestion Read Me. Verified: app typechecks + builds, worker
loads with all modes wired, workflows are valid YAML, and the DB transitions
were checked against local Postgres.

## Migration

`0014_onboard_phase.sql` — adds `onboard_phase` to `sync_state`
(`calibrating | awaiting_confirmation | confirmed | done`), defaulted to `done`
so pre-existing accounts are never pushed back through onboarding. Additive.

## 5.1 — First-connection onboarding (90-day calibrate → confirm → full ingest)

Previously, connecting a Gmail card immediately dispatched a 1-year full
backfill. Now:

1. **Connect** (`POST /api/gmail/ingest`) sets `onboard_phase=calibrating` and
   dispatches **`calibrate.yml`** (new) instead of backfill.
2. **Calibrate** (worker `MODE=calibrate`, new `runCalibrate`) pulls the last
   **90 days**, classifies senders into the three lists **provisionally**, writes
   NO Memory Notes/rollups, and parks the account at `awaiting_confirmation`. No
   LLM key needed — classification is code-only.
3. **Confirm** — the Kanban's "Confirm classification" now also calls
   **`POST /api/gmail/confirm-onboarding`** (new), which flips awaiting accounts
   to `confirmed` and dispatches the full `backfill.yml`, now running against the
   CONFIRMED sender lists.

## 5.2 — Sender-move backfill (the two confirmed rows)

Moving a sender to a richer tier reprocesses that ONE sender's history at the
new shape (Email Ingestion Read Me):

- `PATCH /api/senders` detects **Marketing → People** and **Marketing → Updates**
  moves and dispatches **`sender-backfill.yml`** (new) with the sender address.
- Worker `MODE=sender-backfill` (`runSenderBackfill`, gated on `ONLY_SENDER`)
  reprocesses that sender's full history via a Gmail `from:<addr>` search; the
  now-updated `sender_classification` routes the mail to the richer tier, and the
  ledger's unique `(user_email, gmail_msg_id)` keeps it idempotent.
- Lighter-tier moves never delete and trigger no backfill (the safe default).
  The four extrapolated move rows the ReadMe flags as open are NOT implemented.

## 5.3 — Daily deleted-email reconciliation

- **`trash-reconcile.yml`** (new) runs daily (`30 5 * * *`) and is dispatchable
  per-user.
- Worker `MODE=trash-reconcile` (`runTrashReconcile`) lists Gmail **Trash** within
  the 30-day window, matches against ingested `email_message` rows, and:
  - a deleted email that produced a **Memory Note** → the user is flagged
    directly (ledger `process_error` marker) plus a rollup line;
  - Ignore/Updates-tier deletions → one line in a per-day **`deletions`** rollup
    (same shape as the Ignored Daily Note);
  - nothing is written on a zero-deletion day.

## New / changed files

- `supabase/migrations/0014_onboard_phase.sql`
- `worker/src/index.js` — `runCalibrate`, `runTrashReconcile`, `runSenderBackfill`,
  mode wiring, `ONLY_SENDER`.
- `worker/src/lib/gmail.js` — `listMessageIds` gains a `fromSender` filter.
- `worker/src/pipeline/ingest.js` — exports `appendRollup` / `hhmm` (reused).
- `lib/gmail/dispatch.ts` — shared workflow-dispatch helper.
- `app/api/gmail/ingest/route.ts` — dispatch calibrate, not backfill.
- `app/api/gmail/confirm-onboarding/route.ts` — release full ingest on confirm.
- `app/api/senders/route.ts` — dispatch sender-backfill on qualifying moves.
- `app/page.tsx` — Kanban confirm also calls confirm-onboarding.
- `.github/workflows/{calibrate,trash-reconcile,sender-backfill}.yml`.

## Deployment

1. Apply migration `0014` to Supabase.
2. Deploy the updated worker + app, and commit the three new workflows so GitHub
   Actions registers them. `GH_REPO` / `GH_DISPATCH_TOKEN` must be set (already
   required by the existing backfill dispatch); the workflows reuse the existing
   `ingestion` environment secrets. Nothing in Redis/Upstash.

## Notes / caveats

- **GitHub cron is best-effort** — the daily trash job can drift or skip under
  load, and schedules auto-disable after 60 days of repo inactivity. Fine for a
  daily reconciliation; drive from an external scheduler if you need guarantees.
- **Calibration re-run on reconnect.** Reconnecting a card resets it to
  `calibrating`. Existing accounts (phase `done`) are untouched.
- **Full-backfill still runs a broad reprocess.** confirm-onboarding dispatches
  the standard full backfill (all mail), now against confirmed lists — it does
  not re-run calibration. The ledger de-dupes, so re-ingesting is safe.
