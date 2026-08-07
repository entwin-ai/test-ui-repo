# Phase 3 — Entity-day batching & facet decomposition

Phase 3 changes the WhatsApp **note boundary**. Until now the pipeline wrote one
Memory Note per message. The WhatsApp Ingestion Read Me (§1) requires a coherent
day's exchange for one entity to be read **once** and split by **facet** — one
note per domain-plus-intent cluster, not per message and not per day by default.
This is the largest WhatsApp change and it rewrites the vectorize pipeline around
the tier decision Phase 2 produces.

## What the pipeline does now (`worker/src/pipeline/whatsapp.js`)

1. **Bucket, then decide.** It loads the run's unprocessed `whatsapp_message`
   rows and groups them into **(identity_key, calendar-day)** buckets *before*
   any LLM call — loading a whole window first so a decomposition sees the
   entity's entire day, never a page fragment.
2. **Classify each entity once** via Phase 2's `classifyMany` (one batched pass,
   not one query per message).
3. **Route each entity-day by tier:**
   - **Ignore** (archived) → write **nothing** — no note, no gist, no rollup
     (Read Me §4). The day's rows are marked processed with `wa_tier='ignore'`.
   - **Important** → `decomposeChatDayFacets` reads the day's transcript and
     returns **N facets**; the pipeline writes **one Memory Note per facet**,
     each with its own `raw_summary`, the four system-context fields, and its own
     `related_entities`.
   - **Updates** → `summarizeChatDay` collapses the day to **one note**, no facet
     split. *This is the Phase 3 bridge* — Phase 4 replaces it with the gist-line
     rollup + dual failsafe. Until then, Updates days are a single collapsed note
     rather than regressing to one-per-message.
4. **Same v5 write path per note.** Every produced note goes through the
   unchanged insert → `resolveEntitiesForNote` → chunk/embed path, so WhatsApp
   notes still unify into one entity graph and one RAG index. `note_id`
   sequencing now issues **multiple ids per entity-day** (one per facet).

## New prompts (`worker/src/lib/prompts.js`)

- **`decomposeChatDayFacets`** — the Important-tier facet prompt from Read Me
  §10. Reads one entity's day and returns `{ facets: [...] }`; two messages share
  a facet only if they share both topic and intent. A quiet day yields one facet;
  a busy multi-topic day yields several. Output is normalized and always yields
  at least one facet.
- **`summarizeChatDay`** — the Updates-tier bridge collapse (one note per day).

The old `writeChatNoteAndEntities` (one message → one note) is retained because
the Slack pipeline still uses it; it is simply no longer on the WhatsApp path.

## Idempotency & failure handling

- Every constituent message row of a processed entity-day is stamped
  `processed_at`, so a re-run never re-buckets it.
- If a bucket throws mid-way, its rows are left **unprocessed** (a `process_error`
  is recorded) so a later run retries the whole day cleanly, without half-writing
  it. One bucket failing never blocks the others.
- The backfill/delta high-water-mark bookkeeping in the two entry points is
  unchanged.

## Anchor row & source links

A facet can span many messages, but `memory_note.wa_message_id` links to one
ledger row — so each note anchors to the day's **last** message (its
representative), and the `wa.me` deep link resolves from that chat's jid (1:1
only; groups/communities have no `wa.me` target), exactly as before.

## Verify

After deploying the worker (no new migration or workflow in this phase — it
reuses Phase 1's `whatsapp_entity` and Phase 2's `whatsapp_classification` and
`wa_tier` columns):

- An Important 1:1 with a genuinely multi-topic day should now yield **several**
  `memory_note` rows for that date, each with distinct `related_entities` —
  where before it produced one note per message.
- An Updates group day should yield **one** note.
- An archived chat should yield **zero** notes, with its messages marked
  `wa_tier='ignore'`.

This was validated end-to-end against a stubbed provider/DB: a 1:1 work+dinner
day produced two facet notes, a muted group produced one collapsed note, and an
archived entity produced none — with all message rows marked processed.

## What this unblocks

- **Phase 4** replaces the Updates bridge (`summarizeChatDay` → one note) with
  the gist-line rollup into the WhatsApp Updates Note plus the dual failsafe
  (@mention or urgency → reroute the day into this facet-split path).
- **Phase 5**'s Updates→Important backfill re-runs exactly this facet-split path
  over past days.
