# Change — Gmail card shows ingestion progress, then "Total X emails ingested"

## What was asked

For a Gmail card, once Connect is clicked: hide "Email ingestion for the vault."
and "Not connected", show "Ingestion is in-progress"; and once the
`gmail-calibrate` GitHub Action finishes ingesting that mailbox, show
"Total X emails ingested", where X comes from the job/database (not a made-up
number).

## How it works

The count is real and DB-backed. The gmail-calibrate worker writes one
`email_message` row per ingested email and advances `sync_state.onboard_phase`
(`calibrating` → `calibrated`) / `backfill_done`. The card reads both from a new
endpoint.

- **New endpoint** `GET /api/gmail/ingest-status?card=…` returns, scoped to the
  session user + card:
  - `ingestedCount` — `count(email_message)` (the "X").
  - `inProgress` — a `sync_state` row exists but hasn't reached a terminal phase.
  - `done` — `backfill_done === true`, or `onboard_phase` is `calibrated`/`done`.

- **Card states** (`app/page.tsx`):
  - On connect, after the calibrate job is dispatched, the card enters
    `ingesting`: the description line and the status both read
    "Ingestion is in-progress", and the scan (inbox/sent) preview is suppressed.
  - A polling effect (every 5s, plus once on mount) reads the ingest-status
    endpoint. When the job completes, the card flips to
    `Total {ingestedCount} emails ingested` — sourced from the DB.
  - Because both the in-progress and completed states come from the DB, a browser
    reload mid-ingestion resumes "in-progress", and a completed run shows the
    count with no reliance on local memory of the run.
  - Disconnect clears the ingestion state (and the poll won't repaint a
    disconnected card).

## Files touched / added

- **added** `app/api/gmail/ingest-status/route.ts` — DB-backed count + phase.
- `app/page.tsx` — ingestion fields on the connector, in-progress/done card copy,
  polling + mount hydration, disconnect reset.

## Notes

- The "in-progress → done" transition is driven by the worker actually running.
  That requires the calibrate workflow to be dispatchable
  (`GH_REPO` + `GH_DISPATCH_TOKEN`) and the worker/DB reachable. Until the job
  writes rows and advances the phase, the card correctly stays "in-progress".
- `X` reflects `email_message` rows, i.e. emails pulled into the vault for that
  card. It climbs as the job ingests and settles when the phase goes terminal.

Verified: `tsc --noEmit` clean, `next build` compiled successfully with
`/api/gmail/ingest-status` registered.
