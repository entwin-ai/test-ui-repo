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
