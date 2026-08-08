# Change — WhatsApp "Read Now" triggers the whatsapp-delta GitHub Action

## What was asked

In the WhatsApp settings popup, the "On-demand check" → "Read Now" button should
trigger a WhatsApp delta GitHub Action to read the difference (new messages).

## How it works now

- **New workflow `whatsapp-delta.yml`** — the on-demand, user-scoped counterpart
  to the hourly `whatsapp-sync` heartbeat. It opens a short-lived Baileys socket
  for the scoped account, drains WhatsApp's offline backlog into the
  `whatsapp_message` ledger (the "difference" since the last read), then
  vectorizes the new rows into memory notes + entities + embeddings.

  It reuses `MODE=whatsapp-sync` (the real capture+vectorize path) scoped by
  `ONLY_USER`. Capture is what pulls new messages off the phone; the separate
  `whatsapp-delta` worker MODE is vectorize-only (no capture) and would NOT read
  new messages, so it is deliberately not used here. The vectorize step only
  touches rows with `processed_at IS NULL`, so first run backfills and later runs
  are true deltas.

  Its concurrency group shares the `wa-sync-<user>` prefix so an on-demand run
  never overlaps the hourly sync for the same device (two sockets for one device
  makes WhatsApp drop both).

- **`Read Now` (WhatsApp)** — `POST /api/connectors/read` dispatches
  `whatsapp-delta.yml` with the signed-in user's email (via the shared
  `dispatchWorkflow` helper). Success updates the modal's "Last read" line; a
  failure (e.g. worker not configured) shows an inline reason — same wiring as
  Gmail's Read Now.

## Files touched / added

- **added** `.github/workflows/whatsapp-delta.yml`
- `app/api/connectors/read/route.ts` — WhatsApp read now dispatches
  `whatsapp-delta.yml` (was `whatsapp-sync.yml`).

## Notes

- Requires `GH_REPO` + `GH_DISPATCH_TOKEN` (Actions read/write); without them,
  "Read Now" reports "Ingestion worker not configured" rather than doing nothing.
  Optional `GH_WORKFLOW_REF` overrides the git ref (default `main`).
- The workflow must be on the default branch before GitHub will accept the
  dispatch — deploy it before relying on Read Now.
- Requires the device to be paired already (via `whatsapp-pair`); an unpaired
  account is skipped by capture.

Verified: `whatsapp-delta.yml` YAML parses, `tsc --noEmit` clean, `next build`
compiled successfully.
