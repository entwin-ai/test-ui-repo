# Change — "Read Now" triggers the gmail-delta GitHub Action

## What was asked

In the Gmail-personal settings popup, the "On-demand check" → "Read Now" button
should trigger the Gmail delta GitHub Action to read the difference (new/changed
mail), rather than the old synchronous inbox/sent count.

## How it works now

- **`Read Now` (Gmail)** → `POST /api/connectors/read` now dispatches the
  `gmail-delta` workflow (`delta.yml`) via GitHub `workflow_dispatch`, scoped to
  the signed-in user and the specific card, with `force=true`. The worker runs a
  differential sync for just that account and pulls only new/changed emails.
  ("Read Now" for Slack/WhatsApp is unchanged; Slack still does its scan,
  WhatsApp dispatches its sync workflow.)

- **`delta.yml`** gained `workflow_dispatch` inputs — `user_email`, `card_id`,
  and `force` — plus a per-user `run-name` marker and a per-user concurrency
  group so an on-demand run never queues behind the hourly all-accounts
  heartbeat. On the scheduled run these inputs are blank and behavior is
  unchanged (all due accounts, normal cadence).

- **Worker** (`worker/src/index.js`) honors `FORCE_DELTA=true` to bypass the
  per-user `pollHours` cadence gate, so an on-demand "Read Now" runs immediately
  regardless of when the last delta ran. The existing `ONLY_USER` / `ONLY_CARD`
  filters scope it to the one account.

- **Result surfacing**: the route returns the dispatch outcome, and the modal
  already shows it — success updates the "Last read" line; a failure (e.g. the
  ingestion worker isn't configured) shows an inline reason.

## Files touched

- `.github/workflows/delta.yml` — dispatch inputs, run-name, concurrency group.
- `worker/src/index.js` — `FORCE_DELTA` bypass of the cadence gate.
- `lib/connectors/meta.ts` — Gmail `readKind` is now `gmail-delta`.
- `app/api/connectors/read/route.ts` — dispatch `delta.yml` for Gmail (shared
  `dispatchWorkflow` helper; WhatsApp reuses it too).

## Notes

- Requires `GH_REPO` + `GH_DISPATCH_TOKEN` (Actions read/write). Without them,
  "Read Now" reports "Ingestion worker not configured" instead of silently doing
  nothing. Optional `GH_WORKFLOW_REF` overrides the git ref (default `main`).
- `delta.yml`'s new inputs must be on the default branch for dispatch to accept
  them — deploy the workflow change before relying on Read Now.

Verified: `delta.yml` YAML parses, `node --check` on the worker, `tsc --noEmit`
clean, `next build` compiled successfully.
