# Slack connector

Clicking **Connect** on the Slack card runs a Slack OAuth (v2) flow and then
pulls **the last 1 month of Slack chats** across every conversation the
authorizing user can read (public + private channels, DMs, group DMs), showing
total messages, active-channel count, and the busiest channels on the card.

The implementation mirrors the Gmail connector exactly:

| Concern            | Gmail                     | Slack                       |
| ------------------ | ------------------------- | --------------------------- |
| OAuth start        | `/api/gmail/authorize`    | `/api/slack/authorize`      |
| OAuth callback     | `/api/gmail/callback`     | `/api/slack/callback`       |
| Read/scan          | `/api/gmail/scan`         | `/api/slack/scan`           |
| Status             | `/api/gmail/status`       | `/api/slack/status`         |
| Disconnect         | `/api/gmail/disconnect`   | `/api/slack/disconnect`     |
| Service layer      | `lib/gmail/service.ts`    | `lib/slack/service.ts`      |

Signed, stateless OAuth `state` (HMAC over `NEXTAUTH_SECRET`) and the
globalThis + Upstash-Redis token store are shared design, so callback and scan
can land on different serverless instances without losing the token.

## Environment variables

Add these (Slack app → **Basic Information** / **OAuth & Permissions**):

```
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
```

Reuses the ones Gmail already needs:

```
NEXTAUTH_URL=https://your-app.example.com   # used to build the redirect URI
NEXTAUTH_SECRET=...                          # signs the OAuth state
UPSTASH_REDIS_REST_URL=...                   # durable token store (optional in dev)
UPSTASH_REDIS_REST_TOKEN=...
```

## Slack app configuration

1. Create a Slack app at https://api.slack.com/apps.
2. **OAuth & Permissions → Redirect URLs**: add
   `${NEXTAUTH_URL}/api/slack/callback`.
3. **User Token Scopes** (this connector uses a *user* token, not a bot token):
   `channels:history`, `channels:read`, `groups:history`, `groups:read`,
   `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`.
4. Install the app to your workspace.

## Notes / limits

- Content is **counted**, not permanently stored, matching the Gmail scan
  behaviour. The user token persists so the read can be re-run.
- The scan bounds itself for the serverless budget: up to 25 pages of channel
  enumeration and up to 20 history pages (~4,000 messages) per channel, with
  bounded concurrency (4) to stay under Slack's rate limits. If a cap is hit the
  returned totals are a lower bound (`capped: true`).
- Channels the token can't read (`not_in_channel`, `missing_scope`, …)
  contribute 0 rather than failing the whole read.

## Asynchronous parsing (GitHub Actions)

The interactive scan only *counts*. The actual parsing — pulling every message
and turning it into memory notes + entities + embeddings — happens
**asynchronously in a GitHub Actions worker**, exactly like the Gmail backfill
and WhatsApp sync. Because Slack's Web API is pull-based (no persistent socket),
both capture and vectorize run in one bounded job.

Flow after a Slack card connects:

1. `runSlackScan` (client) finishes the count, then fire-and-forgets
   `POST /api/slack/ingest`.
2. `/api/slack/ingest` upserts a `sync_state` row (`channel='slack'`, a 1-month
   `slack_backfill_after` floor) and dispatches the **`slack-backfill`**
   workflow via the GitHub REST API (`GH_REPO`, `GH_DISPATCH_TOKEN`).
3. The worker (`MODE=slack-sync`, `worker/src/index.js`) for each account:
   - reads the user token from Redis (written by the OAuth callback),
   - **captures** the last month across every readable conversation into the
     `slack_message` ledger (idempotent upsert on
     `user_email, channel_id, ts`), then
   - **vectorizes** unprocessed rows through `writeChatNoteAndEntities` →
     `memory_note` / `note_chunk` / entity resolver — the *same* pipeline Gmail
     and WhatsApp use, so Slack unifies into the same entity graph and RAG index.
4. The **`slack-sync`** workflow re-runs hourly on cron for ongoing delta; it
   only touches `processed_at IS NULL` rows, so re-runs are safe.

New pieces:

| Piece                | Path                                        |
| -------------------- | ------------------------------------------- |
| Ingest dispatch      | `app/api/slack/ingest/route.ts`             |
| Backfill workflow    | `.github/workflows/slack-backfill.yml`      |
| Hourly sync workflow | `.github/workflows/slack-sync.yml`          |
| Worker mode          | `MODE=slack-sync` in `worker/src/index.js`  |
| Capture + vectorize  | `worker/src/pipeline/slack.js`              |
| Slack Web API client | `worker/src/lib/slack.js`                   |
| Token reader (Redis) | `worker/src/lib/redis-slack.js`             |
| Ledger + cursors     | `supabase/migrations/0009_slack_channel.sql`|

Run migration `0009_slack_channel.sql` before first use. The worker needs the
same Actions secrets the Gmail/WhatsApp backfills already use (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_*`, `ENTWIN_KEY_SECRET`, the
embed-model vars) plus the app-side `GH_REPO` and `GH_DISPATCH_TOKEN` for the
dispatch.
