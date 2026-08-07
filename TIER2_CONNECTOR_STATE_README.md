# Tier 2 — Real connector state: Connect/Disconnect + Read Now

Built on Tier 1. The connector-settings modal's connection controls and the
"On-demand check" card were cosmetic; they are now real. Two gaps closed.

## 1. Connect / Disconnect is real (no more hardcoded `sourceStillActive`)

Previously the modal's Disconnect only popped a `window.alert` and flipped a
local flag, and Connect always bounced back to "Disconnect" because
`sourceStillActive = true` was hardcoded. Now:

- **Disconnect** → `POST /api/connectors/disconnect { connectorKey }`. Per
  connector type it performs the real teardown:
  - Gmail / Slack: revoke the stored session/token **and** delete the
    `sync_state` row so the worker stops polling (mirrors the per-service
    disconnect routes). Ingested notes are left intact.
  - WhatsApp: unlink the device (drops creds/keys), stopping capture.
  - Backend-less cards (Drive, Calendar, Browser history, Animatics): nothing to
    revoke — the toggle is simply persisted.
  In every case `connector_state.connected` is set false so grid + modal agree.

- **Connect** → `POST /api/connectors/status { connectorKey }` re-checks real
  liveness. For a backend-owned card it reads the actual session/link state; if
  the source has revoked access it does **not** fake a reconnect — it tells the
  user to reconnect from the grid card (which runs the real OAuth/pairing flow).
  Backend-less cards enable on click, since the toggle is their only truth.

A new `lib/connectors/meta.ts` maps each card to its `service`, whether it's
`backendOwned`, and how it reads — so the routes act correctly per connector
instead of treating them all identically. Inline connect/disconnect errors are
surfaced in the modal.

## 2. "Read Now" works and "Last read" is real

Previously the button had no handler and the line was hardcoded "Last read:
Never".

- New column: `connector_state.last_read_at` (migration
  `0019_connector_last_read.sql`; nullable, no backfill).
- `lib/connectors/state.ts` reads it into `ConnectorStateRecord.lastReadAt` and
  gains `touchLastRead(user, key)` (upserts the row if absent).
- `POST /api/connectors/read { connectorKey }` — for a backend-owned card it
  triggers the **real** on-demand read (Gmail/Slack `scan`, WhatsApp sync
  dispatch); for a backend-less card there's nothing to fetch, so it only
  records the timestamp (honest, not faked). The timestamp is recorded even if
  the read errors ("we attempted a read at T"), and the read's own outcome is
  returned separately so the UI can show a failure.
- The recurring worker `delta` pass also stamps `last_read_at`, so the line
  reflects automatic polls, not just manual clicks (best-effort; never fails a
  run).
- UI: the button has `Read Now → Reading… → Read Now` states, the line renders a
  compact relative time ("just now", "3 hours ago", or a date), and a read
  failure is shown inline. The grid's copy of `lastReadAt` updates too.

## Files touched / added

- **added** `supabase/migrations/0019_connector_last_read.sql`
- **added** `lib/connectors/meta.ts` — per-connector capability map
- **added** `app/api/connectors/read/route.ts` — Read Now
- **added** `app/api/connectors/disconnect/route.ts` — real disconnect
- **added** `app/api/connectors/status/route.ts` — liveness for Connect
- **added** `TIER2_CONNECTOR_STATE_README.md`
- `lib/connectors/state.ts` — `lastReadAt` on the record + `touchLastRead`
- `app/page.tsx` — real connect/disconnect/read handlers, `timeAgo`, wiring
- `worker/src/index.js` — stamp `last_read_at` on delta

Verified: `tsc --noEmit` clean, `next build` compiled successfully with all
three new `/api/connectors/*` routes registered, `node --check` on the worker.

## Deploy note

Run migration `0019_connector_last_read.sql` before deploying (adds one nullable
column; safe/idempotent via `add column if not exists`). Cards never read show
"Never" — the honest empty state.
