# Kill My Twin — total per-user teardown

The "Kill My Twin" button at the bottom of the Settings tab permanently deletes
**everything** Entwin holds for the signed-in user. It is irreversible and
gated behind a confirm dialog.

## What gets deleted

`DELETE /api/twin` → `lib/twin/teardown.ts::killTwin(email)` removes, scoped to
the user's session email (never request input):

**Supabase — every row keyed by `user_email`, in child→parent order:**
`entity_mention`, `note_chunk`, `memory_note`, `daily_rollup`, `email_message`,
`slack_message`, `whatsapp_message`, `entity`, `llm_cost_log`, `sync_state`,
`connector_state`. That covers all ingested data (Gmail/Slack/WhatsApp), all
derived memory/entities/rollups, the cost ledger, every connector's saved
settings, and the sync bookkeeping.

**Redis (Upstash) — every credential and blob the user has:**
the encrypted LLM API key (`entwin:llm:*`), the cached profile
(`entwin:profile:*`), both Gmail sessions (`entwin:gmail:*`), the Slack session
(`entwin:slack:*`), both Google Drive sessions (`entwin:drive:*`), the WhatsApp
creds/keys/paircode (`entwin:wa:*`), and the Animatics pipeline state — the job
blob (`entwin:animatics:job:*`), every character headshot
(`entwin:animatics:headshot:*`), and the owner index (`entwin:animatics:owner:*`).
Credential keys are hashed, so they're reconstructed from the email + known card
ids. The Animatics job/headshot keys are keyed by a random job id, so they're
resolved dynamically: the owner index (email-derived) points at the job, the job
blob lists its headshots. The schemes are mirrored from the channel/animatics
services and noted in `teardown.ts`.

**Scheduled GitHub Actions services — decommissioned:**
the delta/sync workflows are shared crons that enumerate `sync_state`. Deleting
the user's `sync_state` rows (above) means the worker never processes that user
again — that is the decommission. Revoking the Redis tokens is the second layer:
even a run already in flight can no longer authenticate to the user's accounts.
There is no per-user GitHub cron object to delete, so nothing is left dangling.

After a successful delete the client signs the user out and returns to the
landing screen.

## Behaviour and failure handling

- The teardown is **best-effort and continues past individual failures** so a
  single error can't strand the user half-deleted. It returns a per-step report.
- HTTP status: `200` when everything cleared, `207 Multi-Status` if some steps
  failed. On `207` the button shows which parts failed and invites a retry
  (re-running is safe — deletes are idempotent).

## Files

- `lib/twin/teardown.ts` — the teardown logic (Supabase + Redis).
- `app/api/twin/route.ts` — `DELETE /api/twin`, session-scoped.
- `app/page.tsx` — the wired button with confirm, busy, and error states.
- `app/globals.css` — button + error styling.

## Deployment

No new migration, env vars, or secrets — it reuses the existing
`SUPABASE_*` and `UPSTASH_REDIS_*` credentials. Just deploy the updated app.

## Notes / possible extensions

- **Auth record**: the user's NextAuth/Google identity is not stored by Entwin
  (there's no users table), so there's nothing app-side to delete beyond ending
  the session. If you later add a users/accounts table, add it to `USER_TABLES`.
- **In-flight run cancellation**: if you want to also hard-cancel any GitHub
  Actions run already executing for the user at the moment of deletion, that
  needs a GitHub API call listing in-progress runs; it can't be filtered by
  dispatch input, so it isn't done here. Token revocation already neutralizes any
  such run. Add it only if you have a way to attribute runs to a user safely.
