# WhatsApp pairing/sync fix — build marker

If this file is present in your deployed repo, the fixes below are live.
If it is NOT in the repo GitHub Actions runs, you deployed the wrong build.

Changed files:
- worker/src/pair-whatsapp.js       — request pairing code up front (not on `qr`);
                                       reconnect through 515/428 restart to `open`;
                                       FORCE_REPAIR=1 clears a stale link first.
- worker/src/pipeline/whatsapp-capture.js — reconnect through 515/428 so the first
                                       capture reaches `open` and drains offline
                                       history (was silently persisting 0 rows).
- .github/workflows/whatsapp-pair.yml — adds `force_repair` dispatch input.

## Re-pair cleanly (your current 428)
Actions → whatsapp-pair → Run workflow:
  user_email = your email
  phone      = 13125095157
  force_repair = TRUE      <-- important: wipes the stale link
Read the printed code, enter it on the phone, let the job finish (it now rides
through the restart instead of dying at 428).

Then run whatsapp-sync (dispatch), and: select count(*) from whatsapp_message;

## Update — sender names + consistent 1-month per-chat backfill
- worker/src/lib/wa-names.js (NEW) — name registry: resolves chat_name (group
  subject / contact) and sender_name (per message, always populated) from the
  contacts + chats directories, not the last speaker's pushName.
- worker/src/pipeline/whatsapp-capture.js — wires the registry into all name
  sources; on a first (backfill) ingestion, walks EACH chat back ~1 month via
  on-demand history (sock.fetchMessageHistory) until every chat crosses the
  floor; upsert now UPDATES name columns as they resolve. Marks backfill_done
  + wa_backfill_after when complete. Backfill runs get a longer drain ceiling.
- supabase/migrations/0008_whatsapp_names.sql (NEW) — adds is_group; backfills it.
- worker/package.json — baileys pinned to ^7.0.0-rc.14 (has fetchMessageHistory).

### Env knobs (optional)
  WA_BACKFILL_DAYS=30        # per-chat history depth on first ingestion
  WA_HISTORY_PAGE=50         # messages per on-demand fetch
  WA_HISTORY_ROUNDS=12       # max fetch rounds per chat (time-budget guard)
  WA_BACKFILL_DRAIN_MS=300000  # first-ingestion drain ceiling (5 min)

### KNOWN: apply migration 0008 BEFORE running, or is_group errors zero the run.
### The persist now retries without is_group on a stale schema cache, and
### backfill_done is only stamped when rows actually persist.

### To re-run the initial ingestion after deploying
Reset the account so it takes the backfill path again, then dispatch sync:
  update sync_state set backfill_done=false, wa_backfill_after=null
    where user_email='nishitghosh@gmail.com' and channel='whatsapp';

## Update — pairing code shown in the connectors tab (no more log-diving)
- worker/src/lib/wa-paircode.js (NEW) — publishes the code to Redis
  (entwin:wa:paircode:<hash>, TTL = pairing timeout), cleared on link.
- worker/src/pair-whatsapp.js — publishes the code when generated, clears on
  successful `open`. Log still prints it as a fallback.
- lib/whatsapp/service.ts — status() now reads the code and returns
  `pairingCode` / `pairingCodeExpiresAt` (only while unlinked).
- app/page.tsx — the WhatsApp modal polls status, and when a code is present
  renders it as digit tiles with a Copy button; the Actions-log link is now a
  fallback shown only until the code arrives.
- app/globals.css — .wa-paircode styles.

No new secrets/inputs. Uses the existing Upstash Redis env already set for the
pair/sync jobs. Code appears within ~3–7s of dispatch (job spin-up + 3s request
delay + the UI's 4s poll).
