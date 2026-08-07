# Phase 0 — WhatsApp ingestion-layer capability probe

Phase 0 of the WhatsApp Ingestion Read Me build plan is a **verification spike**,
not a feature. Nothing about tiering, facets, or the Kanban ships here. The whole
point is to answer — against the **real** ingestion layer (Baileys), not against
assumptions — the questions that decide whether later phases can be built as
specified. Several Phase 1/2/6 requirements are *conditional* on these answers,
so we confirm them before writing that code, not after.

This phase has two kinds of deliverable:

1. **Machine-verified findings (0.1–0.3)** — produced by a read-only probe that
   opens a short-lived socket and inspects the metadata surface. See below.
2. **Policy decisions (0.4)** — four open items from the Read Me that are product
   calls, not code. Captured with recommended defaults in
   `PHASE0_DECISION_RECORD.md`.

## What the probe checks

| Q | Question | Gates |
|---|----------|-------|
| 0.1 | Are per-chat metadata fields readable at capture time? (group vs 1:1 vs community, muted, member_count, self-admin, archived, community parentage, community-admin) | Phase 1 (metadata columns) + Phase 2 (tier rules) |
| 0.2 | Does the WhatsApp username surface with a **stable, account-tied identifier**, or only editable display text? | Phase 1.3 (username alias) + Phase 6.2.1 (username auto-merge) |
| 0.3 | Is archived state **re-readable each run**, and is unarchiving detectable? | Phase 2 Ignore-tier live override |

The probe **reads no message bodies, writes no memory notes, and never touches
`sync_state`.** It is read-only by construction and safe to run against a live
linked account at any time. It needs no LLM key.

## Files added in this phase

- `worker/src/pipeline/whatsapp-probe.js` — the read-only probe.
- `worker/src/index.js` — `MODE=whatsapp-probe` dispatch (no LLM, no per-account
  ingest; enumerates linked accounts and probes each).
- `worker/package.json` — `npm run probe` convenience script.
- `.github/workflows/whatsapp-probe.yml` — manual-dispatch workflow (no cron).
- `supabase/migrations/0015_whatsapp_capability_probe.sql` — results table.
- `PHASE0_DECISION_RECORD.md` — the 0.4 policy calls.

Nothing in the existing capture/vectorize path changed.

## How to run

**Apply the migration first** (`0015_whatsapp_capability_probe.sql`), then either:

- **GitHub Actions:** run the `whatsapp-probe` workflow from the Actions tab.
  Optionally scope to one `user_email`. Read the run log for the summary; the
  full result also lands in `whatsapp_capability_probe`.
- **Locally:**
  ```bash
  cd worker
  ONLY_USER=you@example.com \
  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… ENTWIN_KEY_SECRET=… \
  npm run probe
  ```

> **Run it against a representative account.** The account should be in **at
> least one group and one community**, otherwise the group/community/admin
> findings come back `UNCONFIRMED` — the probe flags this explicitly in its
> `WARN:` lines rather than reporting a false "no".

## Reading the result

The probe prints a summary and writes one row to `whatsapp_capability_probe`.
Each metadata field carries both an availability boolean and a coverage percent
(present-on-N-of-M eligible chats), because "the field exists on the type but is
absent on most chats" is itself a finding Phase 2 must plan around.

The three decisions the row drives:

- **0.1 → Phase 1/2 go/no-go per field.** If `member_count_available`,
  `self_admin_available`, `muted_available`, `archived_available`,
  `community_*_available` are all `YES` at healthy coverage, Phase 2's
  deterministic rules (Read Me §5) are buildable as written. Any `no` means that
  rule needs a fallback (e.g. treat unknown-admin as non-admin) — record it in
  the decision record before Phase 2 starts.
- **0.2 → `username_durability`.**
  - `durable` → Phase 6.2.1 username auto-merge is greenlit; store the
    `username_field_path` as the alias key in Phase 1.3.
  - `text_only` → auto-merge **must degrade** to a fuzzy signal (Read Me caveat).
    Phase 6.2.1 as specified is **not** built; the changed-number case relies on
    the fuzzy band + `pending_review` only.
  - `absent` / `unknown` → re-run against an account where a contact has set a
    username before deciding; do not greenlit 6.2.1 on an unknown.
- **0.3 → `archived_live_readable` / `unarchive_detectable`.** Both `YES` means
  the Ignore override can be evaluated live every run (Read Me §4). If archived
  is not re-readable, the Ignore tier needs a different mechanism — flag before
  Phase 2.

## Exit criteria for Phase 0

Phase 0 is done when:

1. A probe run against a representative account has populated
   `whatsapp_capability_probe` with **no `UNCONFIRMED` warnings** (i.e. groups
   and communities were actually observed).
2. Each 0.1 field is marked available-or-not, and any `no` has a recorded
   fallback decision.
3. `username_durability` is `durable` or `text_only` (not `unknown`), and the
   Phase 6.2.1 go/no-go is recorded.
4. `PHASE0_DECISION_RECORD.md` has all four 0.4 items marked **Decided** (not
   **Proposed**) by the product owner.

Only then do Phases 1 and 6 have the inputs they need.
