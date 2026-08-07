# Phase 3 — Email classification rewrite (backend)

Phase 3 of the merged build plan. Replaces the old overlapping-filters classify
step with the persisted, per-address sender-list model from the Email Ingestion
Read Me. Backend/worker only — the Kanban UI that sits on top of this is Phase 4.
Verified with pure-function unit tests (ReadMe's own examples) and live-Postgres
tests of the DB flow.

## What changed

### `worker/src/lib/sender-classification.js` — new (3.1–3.5)
The real classifier. For one email it:
- **extracts the EXACT sender address** (`Name <a@b.com>` → `a@b.com`), lowercased
  — never the parent domain (3.2). One org can legitimately sit on all three
  lists at once via different addresses.
- **reads `sender_classification`** keyed on that exact address and maps its
  `list` → tier (`marketing→ignore`, `updates→storage`, `people→memory`) (3.1).
- for an **unseen sender**, runs the **bootstrap heuristic** and persists a
  PROVISIONAL (`confirmed=false`) row for the Kanban to surface (3.4). The
  heuristic is the ONLY place `List-Unsubscribe` is consulted — as a first-seen
  bulk hint, never as an override on a known sender (3.3).
- when a sender row carries an **entity_id**, **pre-seeds that entity's alias
  index** with the sender's display name + address — the dual-classification tag
  (3.5). This never creates a mention, so it never inflates bubble size.
- returns `category` (bank/social/transaction/update) for storage-tier senders so
  the Daily Updates rollup entry keeps its functional tag.

### `worker/src/lib/classify.js` — rewritten
Now a thin async wrapper delegating to `classifySender`. `classify()` is ASYNC
(it reads/writes the sender table); the single caller awaits it.

### `worker/src/pipeline/ingest.js` — call site
`classify({headers,sender})` → `await classify(user_email, {headers,sender})`.
The downstream tier routing (ignore→rollup, storage→updates summary + urgency
reclassify, memory→note pipeline) is unchanged and still consumes
`decision.tier/reason/category`.

## Verified behavior

- **Exact-address keying** — three addresses on one domain (`marketing@`,
  `alerts@`, `rm.jane@` of the same bank) correctly hold Marketing / Updates /
  People. Domain-keying would collapse them; this is the bug the rule prevents.
- **Provisional placement** — unseen senders persist `confirmed=false` with a
  `bootstrap_reason`.
- **Dual classification** — an entity-tagged sender seeds that entity's aliases.
- **Idempotent** — re-encountering a confirmed sender never flips it back to
  provisional (the upsert is `on conflict do nothing`).
- **Bootstrap** — unsubscribe header / bulk local-parts (`noreply@`, `offers@`)
  / bulk domain prefixes (`enews.`, `mail.`) → Marketing; ordinary addresses →
  People; all provisional until confirmed.

## Behavior notes / limits

- **Category is heuristic.** With the list no longer carrying a category, the
  bank/social/transaction tag for the Updates rollup is derived from a small
  domain-pattern table (`CATEGORY_HINTS`). Extend it as needed; unknown → `update`.
- **First-seen senders still ingest immediately.** A new sender is placed
  provisionally and its mail is handled at that tier right away — ingestion is
  never blocked waiting for confirmation. The Kanban (Phase 4) is where the user
  corrects placements; the onboarding 90-day-calibration-then-confirm flow is
  Phase 5.
- **Bootstrap default is People (tier 3).** Per the ReadMe, "any sender not yet
  classified" is memory-worthy, so an unknown non-bulk sender defaults to People
  rather than being dropped. This errs toward keeping mail, which is the safe
  default; the user can demote on the Kanban.

## Deployment

Requires migration 0013 (Phase 1) applied. No new migration, env var, or secret
in this phase — deploy the updated `worker/`. Nothing in Redis/Upstash.

Existing `email_message` rows already carry a `tier`; this only changes how
FUTURE mail is classified. To reclassify historical senders under the new model,
they surface on the Kanban as they recur, or re-run ingestion.
