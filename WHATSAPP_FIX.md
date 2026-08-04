# WhatsApp build marker — FULL patched build

If this file is in the repo GitHub Actions/Vercel build from, ALL fixes below are
live. If it's absent, you deployed an older tree (this has happened before —
the zip downloaded from chat must actually be committed & pushed to the repo).

## Everything included in this build
1. Pairing (worker/src/pair-whatsapp.js): request code up front (not on `qr`);
   reconnect through 515/428 to `open`; FORCE_REPAIR=1 clears a stale link;
   Browsers.ubuntu('Chrome'); PUBLISHES the code to Redis for the UI.
2. Capture (worker/src/pipeline/whatsapp-capture.js): reconnect through 515/428;
   name registry for chat_name/sender_name; per-chat ~1-month on-demand history
   walk on first ingestion; is_group; retry-without-is_group on stale schema
   cache; backfill_done only stamped when rows actually persist.
3. worker/src/lib/wa-names.js (NEW) — name resolver.
4. worker/src/lib/wa-paircode.js (NEW) — publish/clear pairing code in Redis.
5. lib/whatsapp/service.ts — status() returns pairingCode / pairingCodeExpiresAt.
6. app/page.tsx — WhatsApp modal shows the code as digit tiles + Copy button.
7. app/globals.css — .wa-paircode styles.
8. supabase/migrations/0008_whatsapp_names.sql (NEW) — is_group + schema reload.
9. .github/workflows/whatsapp-pair.yml — force_repair input.
10. worker/package.json — baileys pinned ^7.0.0-rc.14.

## IMPORTANT: the code shows in the MODAL, not the mini-card
The connectors mini-card only ever shows a status line ("Pairing — enter code on
phone"). The CODE appears inside the WhatsApp CONNECT MODAL that opens when you
click Connect/Pairing. If you closed the modal, reopen it — the modal polls
status and renders the code.

## Deploy checklist
- Commit & push THIS tree to the repo Actions/Vercel builds from.
- Apply supabase/migrations/0008_whatsapp_names.sql.
- Same Upstash Redis env in BOTH the app and the workflow (app reads what the
  worker writes; mismatched creds = no code in UI).
- Click Connect, keep the modal open; code appears in ~3–7s.
