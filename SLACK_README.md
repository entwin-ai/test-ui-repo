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

## Asynchronous parsing (GitHub Actions) — three-tier, entity-day, facet-split

The interactive scan only *counts*. The actual parsing happens
**asynchronously in a GitHub Actions worker**, like the Gmail backfill and
WhatsApp sync. Because Slack's Web API is pull-based (no persistent socket), both
capture and vectorize run in one bounded job.

As of the Slack Ingestion Read Me build, the vectorize half is **no longer a
naive one-message-one-note pass**. It now implements the full Read Me: a
three-tier, entity-day, facet-decomposition pipeline that mirrors WhatsApp's
shape (the Read Me explicitly "follows closely" WhatsApp's two-tier Kanban and
entity-day boundary).

### Capture (`captureSlack`)

For each account the worker reads the user token from Redis and, for **every**
readable conversation (archived included):

- Harvests **entity metadata** into `slack_entity`, keyed to a *durable platform
  ID* — user ID for an individual, group DM ID for a group chat, channel ID for
  a closed/public channel, and a shape-dependent key for a Slack Connect
  external connection (Read Me §2, §7). Never the display name.
- **Filters bot + system messages before classification** (Read Me §10): CI /
  issue-tracker / integration posts and join/leave/topic system messages never
  reach facet decomposition or the Updates gist.
- Drains the last month of real messages **plus attachments** into
  `slack_message` (idempotent upsert on `user_email, channel_id, ts`).
- **Archived conversations** (Read Me §4) are enumerated so their live archived
  state is recorded, but their history is *not* pulled — they are the Ignore
  tier and produce nothing.

### Vectorize (`ingestSlackBackfill` / `ingestSlackDelta`)

Unprocessed rows are bucketed by **(entity, calendar day)** — the fixed outer
note boundary (Read Me §1) — each entity is classified **once**, and each
entity-day is routed:

| Tier | Entities (by type, Read Me §5) | What gets written |
| --- | --- | --- |
| **Ignore** | any archived entity | Nothing. No note, no gist, no rollup (Read Me §4). |
| **Updates** | public channels | One gist line per channel-day in the `slack_updates` daily rollup — *unless* a failsafe fires (Read Me §5, §6). |
| **Important** | individuals, external, group chats, closed channels | One facet-split Memory Note **per facet** (Read Me §1, §3), a linked note **per attachment** (Read Me §9), and `action_edges` chaining the day to the entity's prior days (Read Me §1). |

- **Dual failsafe** (Read Me §6): the same one narrow call that produces a public
  channel's gist also carries the failsafe. A **direct `@mention`** of the
  authorizing user (detected deterministically in code as `<@Uxxxx>` *and* by the
  LLM) or **LLM-judged urgency** promotes the channel-day into the full
  facet-split path instead of a gist.
- **Muting is a no-op** for classification (Read Me §4) — public channels are
  Updates and Important entities stay Important regardless of mute state.
- Notes carry `source='slack'` and flow through the *same* resolver +
  `note_chunk` + ivfflat index as Gmail and WhatsApp, so Slack unifies into one
  entity graph and one RAG index.

### Kanban (Read Me §8)

A two-column **Slack Kanban** (Updates / Important Slack Entities) with search
and scrollable columns lives in the dashboard. Archived entities never appear
(they're the Ignore tier). Moving an entity **Updates → Important** dispatches
`slack-move-backfill`, which re-expands every past gist day into full facet notes
and strips the superseded gist lines. **Important → Updates** needs no
backfill — existing notes stand; only new days log as gist.

New pieces:

| Piece                     | Path                                                      |
| ------------------------- | --------------------------------------------------------- |
| Tiered capture + vectorize| `worker/src/pipeline/slack.js`                            |
| Entity metadata collector | `worker/src/lib/slack-entities.js`                        |
| Tier classifier           | `worker/src/lib/slack-classification.js`                 |
| Facet + gist/failsafe prompts | `decomposeSlackDayFacets`, `slackUpdatesGistAndFailsafe` in `worker/src/lib/prompts.js` |
| Entity + classification schema | `supabase/migrations/0023_slack_entity_classification.sql` |
| Kanban API                | `app/api/slack/entities/route.ts`                        |
| Kanban panel              | `SlackKanbanPanel` in `app/page.tsx`                     |
| Move-backfill workflow    | `.github/workflows/slack-move-backfill.yml`              |
| Worker mode               | `MODE=slack-move-backfill` in `worker/src/index.js`      |
| Ledger + cursors (base)   | `supabase/migrations/0009_slack_channel.sql`             |
| Slack Web API client      | `worker/src/lib/slack.js`                                |
| Token reader (Redis)      | `worker/src/lib/redis-slack.js`                          |

Run migrations `0009_slack_channel.sql` **then** `0023_slack_entity_classification.sql`
before first use. The worker needs the same Actions secrets the Gmail/WhatsApp
backfills already use (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`UPSTASH_REDIS_REST_*`, `ENTWIN_KEY_SECRET`, the embed-model vars) plus the
app-side `GH_REPO` and `GH_DISPATCH_TOKEN` for the dispatch.

## Open items carried from the Read Me

- **Ignore-tier audit trail** (§4): no rollup is written for archived entities
  (diverges from email's Ignored Daily Note). Flagged in the Read Me as an
  assumption to confirm.
- **Unarchiving backfill** (§4 open item): the coverage gap while an entity was
  archived is currently left as a permanent gap; a manual re-expansion is
  available via the same move-backfill path if wanted.
- **Multi-workspace** (§12): entity keys are scoped per workspace via `card_id`;
  a second workspace is a separate connector instance.
