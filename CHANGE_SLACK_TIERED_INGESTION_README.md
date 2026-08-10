# Change: Slack tiered ingestion — closing the Read Me gaps

This change brings the Slack connector into line with the **Slack Ingestion
Rules Read Me (v1, 2026-08-05)**. Before it, Slack was a naive
*one-message → one Memory Note* vectorizer. The Read Me requires the same
three-tier, entity-day, facet-decomposition model as WhatsApp. Every gap below
is now closed.

## Gap analysis (Read Me → prior code)

| § | Read Me requirement | Prior code | Status |
| --- | --- | --- | --- |
| §1 | Note boundary is **one entity, one calendar day**; threads that span days split into per-day notes linked by `action_edges` | one note per message | **Closed** — entity-day bucketing + `linkThreadAcrossDays` |
| §2 | Entity identity keyed to a **durable platform ID** (user ID, group DM ID, channel ID), never display name | no entity concept | **Closed** — `slack_entity` + `slack-entities.js` |
| §3 | Exactly three outcomes: **Ignore / Updates / Important**; only Important writes a full note | every message → a note | **Closed** — `slack-classification.js` + routed pipeline |
| §4 | **Ignore = archived**, read live, no audit trail, never on the Kanban | `exclude_archived` at list time; state never read | **Closed** — archived read live; routed to Ignore; excluded from board |
| §4 | **Muting is a no-op** for classification | n/a | **Closed** — mute never consulted |
| §5 | **Updates = public channels by default**, no size/mention/admin trigger; no admin-override | public channels got full notes | **Closed** — type-keyed classifier |
| §6 | **Dual failsafe** (`@mention` / LLM urgency) promotes an Updates channel-day to Important | none | **Closed** — `slackUpdatesGistAndFailsafe` + deterministic `<@Uxxxx>` check |
| §7 | **Slack Connect** identity granularity: 1:1 DM / org-wide / single channel | none | **Closed** — `externalShapeAndKey` + `external_shape` column |
| §8 | Two-bucket **Kanban**, deterministic placement, search + scroll, move backfill | none | **Closed** — `/api/slack/entities`, `SlackKanbanPanel`, `slack-move-backfill` |
| §9 | Each **attachment** in Important activity → its own linked note with a locator; Updates attachments dropped | attachments dropped everywhere | **Closed** — `writeAttachmentNotes` |
| §10 | **Bots + system messages** filtered *ahead of* classification | only join/leave subtypes skipped; bots ingested | **Closed** — `isBotOrSystem` at capture |
| §11 | **Huddles** route to Calls/Video, not here | n/a (no huddle handling) | **N/A** — huddles are not message events; capture only reads `conversations.history`, so they never enter this path (consistent with the Read Me delegating them elsewhere) |
| §12 | **Multi-workspace**: keys scoped per workspace | single card_id | **Closed** — entity/classification keyed by `(user_email, card_id, identity_key)` |

## What changed

**New**

- `supabase/migrations/0023_slack_entity_classification.sql` — `slack_entity`
  (durable-ID metadata + archived + external shape), `slack_classification` (the
  two stored Kanban tiers + manual/bootstrap), and additive `slack_message`
  columns (`slack_entity_type`, `slack_tier`, `slack_tier_reason`,
  `attachments`) + `memory_note.slack_is_attachment`.
- `worker/src/lib/slack-entities.js` — per-run entity registry; durable identity
  keys (§2) and Slack Connect shape resolution (§7).
- `worker/src/lib/slack-classification.js` — type-keyed three-tier classifier;
  archived = absolute Ignore; mute = no-op (§3-5).
- `app/api/slack/entities/route.ts` — Slack Kanban GET/PATCH (§8).
- `.github/workflows/slack-move-backfill.yml` — Updates→Important re-expansion.
- `SlackKanbanPanel` + Slack Kanban subtab in `app/page.tsx`.

**Changed**

- `worker/src/pipeline/slack.js` — rewritten from per-message vectorizer to the
  full tiered, entity-day, facet-split pipeline with attachments, dual failsafe,
  thread `action_edges`, and the move-backfill entry point.
- `worker/src/lib/prompts.js` — added `decomposeSlackDayFacets` and
  `slackUpdatesGistAndFailsafe`.
- `worker/src/lib/slack.js` — `listConversations` no longer excludes archived
  (so Ignore can be read live, §4).
- `worker/src/index.js` — passes `authedUser` into the Slack vectorize path (for
  the `@mention` failsafe) and adds the `MODE=slack-move-backfill` branch.
- `SLACK_README.md` — documents the new architecture.

## Deploy

1. Run migration `0023_slack_entity_classification.sql` (after `0009`).
2. Deploy the app (new route + Kanban panel) and worker (rewritten pipeline +
   new mode).
3. Register `.github/workflows/slack-move-backfill.yml`.
4. The first `slack-sync` after deploy backfills the month through the tiered
   pipeline and populates the Kanban; subsequent hourly runs are delta.

## Verify

- All worker files pass `node --check`.
- The new API route and Kanban panel are type-consistent with their WhatsApp
  counterparts; the only `tsc` errors in this environment are the repo-wide
  missing-`node_modules` ones (`next/server`, `react`, `JSX.IntrinsicElements`,
  `process`) that affect every existing route/page equally.
