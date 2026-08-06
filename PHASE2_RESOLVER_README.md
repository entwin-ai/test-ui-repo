# Phase 2 — Resolver, ownership index & note-linking

Phase 2 of the merged build plan. Builds the entity-layer engine on top of the
Phase 1 schema (migrations 0012/0013). Verified end-to-end against a local
Postgres 16 (three-band scoring, merge, and split all exercised) and the app
typechecks + builds clean.

## What changed

### `worker/src/lib/resolver.js` — rewritten (2.1, 2.2, 2.3)
- **Three-band alias matching (v5 §4).** Exact normalized match → that entity
  (auto-append, unchanged). No/weak candidate → new entity. A fuzzy candidate
  scoring in `[0.62, 0.9)` → a NEW provisional entity flagged `pending_review`
  with `merge_candidate` + `merge_score`; the note still attaches (ingestion is
  never blocked). Scoring is deterministic token-set similarity — no LLM. Exact
  matches short-circuit before scoring, so the common path is unchanged.
- **`matched_alias` (v5 §7).** Every `entity_mention` now records the raw alias
  that justified it.
- **`note_ownership` (v5 §7).** Every resolved reference upserts an ownership row
  with `current_entity_id == resolved_entity_id` at ingestion. Signature of
  `resolveEntitiesForNote` is unchanged, so all four callers (gmail/whatsapp/
  slack ingest + entity-backfill) keep working with no edit.

### `worker/src/pipeline/ingest.js` — action_edges (2.4)
- New `linkThreadEdges` links a new email Memory Note symmetrically to prior
  notes in the same Gmail thread (resolved via `email_message.thread_id`, since
  `memory_note` has no thread column). Direction is never stored (v5 §3). Email
  is the channel with a first-class thread signal; chat channels have no reply
  signal in the current data, so their `action_edges` stay empty until one
  exists (not guessed).

### `lib/entities/operations.ts` — new (2.5)
Shared server-side operations the Phase 4 Entity Review dashboard will call:
- `mergeEntities(source → target)` — repoints mentions, redirects
  `note_ownership.current_entity_id`, folds aliases, and retires the source with
  `merged_into` (source row kept, not deleted, so old references redirect).
- `splitAliases(from, aliases[])` — creates a new entity with `split_from`
  lineage, moves the chosen aliases and their alias-matched mentions/ownership to
  it, and leaves the original with a shorter list (retires nothing).
- `rejectPendingReview(entity)` — clears a provisional flag (the dashboard's
  "these are genuinely distinct" action).

**No Memory Note is ever rewritten** by any of these — only Entity files,
mentions, and the ownership index change (v5 §7). Verified: after a simulated
split, `memory_note.related_entities` was untouched while ownership diverged.

## Behavior notes / limits

- **Divergence is the feature.** After a merge/split, a note's
  `resolved_entity_id` (frozen anchor) differs from `current_entity_id`. That
  divergence is exactly what the Phase 4 "resolved at ingestion vs current
  entity" note display reads — it is not an error.
- **Scoring is token-based.** Partial-name overlaps ("alice" vs "alice johnson",
  "acme" vs "acme corp") land in the review band correctly. Single-token
  spelling variants ("dave" vs "david") do NOT — token-set similarity has no
  character-level distance. This is a conservative first pass; the thresholds
  (`AMBIGUOUS_LOW`/`AMBIGUOUS_HIGH`) and the `similarity()` function are the
  tunable surface if you later want edit-distance blended in.
- **Backfill re-run.** Running the existing `entity-backfill` worker mode will
  now populate `matched_alias` and `note_ownership` for historical notes, and
  will retro-flag ambiguous historical entities as `pending_review`.

## Deployment

Requires Phase 1 migrations (0012/0013) already applied. No new migration, env
var, or secret in this phase — deploy the updated `worker/` and app code.
Nothing to run in Redis/Upstash.
