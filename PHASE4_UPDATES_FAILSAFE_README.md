# Phase 4 — Updates tier: gist note + dual-trigger failsafe

Phase 4 completes the Updates tier. Phase 3 left a bridge — an Updates day was
collapsed into a single Memory Note. Phase 4 replaces that with the real Read Me
§3/§6 behavior: a low-priority group/community day produces **one gist line**
appended to a daily WhatsApp Updates Note, guarded by a **dual failsafe** that
reroutes genuinely important days into the full facet-split pipeline.

## The one-call design (Read Me §6)

For each Updates-tier entity-day the pipeline makes **one** narrow LLM call
(`updatesGistAndFailsafe` in `prompts.js`) that does two jobs at once — the same
one-pass design as email's `updatesSummary`:

```json
{ "gist": "one line of what was discussed",
  "mentioned": false,   // was the account owner directly @mentioned that day?
  "urgent": false }     // pending action / deadline / something this group wouldn't normally carry
```

Keeping the mention check inside this call (rather than pre-filtering in code) is
deliberate: a mention that fires still needs the model to produce note content
downstream, so a separate pass saves nothing.

## Routing (`worker/src/pipeline/whatsapp.js`)

For an Updates entity-day:

- **Neither trigger fires** → append **one gist entry** to that day's WhatsApp
  Updates Note and stop. No Memory Note, no entity resolution, no embeddings
  (Read Me §3 tier 2). The entry is written via the existing `appendRollup`
  helper with `kind='wa_updates'`, keyed on
  `(user_email, card_id='whatsapp', rollup_date, 'wa_updates')` — so it sits in
  the same `daily_rollup` table as email's rollups but never collides with them.
  Each entry carries `{ entity, identity_key, gist, messages }`.
- **Either trigger fires** (`mentioned` **or** `urgent`) → **no gist is written**;
  the entity-day is rerouted into the full facet-split pipeline exactly as an
  Important day would be (Read Me §6), with `wa_tier_reason` recording
  `updates-failsafe-mention` or `updates-failsafe-urgent`.

Ignore (archived) still writes nothing (Phase 3, Read Me §4). Important is
unchanged. On a JSON parse failure the failsafe **fails safe** — the day is
treated as urgent and routed to full notes rather than silently reduced to a
gist.

## What changed

- `worker/src/lib/prompts.js` — added `updatesGistAndFailsafe`; removed the Phase
  3 `summarizeChatDay` bridge it supersedes.
- `worker/src/pipeline/whatsapp.js` — the Updates branch now calls the
  gist+failsafe, appends to the `wa_updates` rollup on the quiet path, and
  reroutes to the facet path on either trigger. Imports `appendRollup` from the
  email pipeline (no new table — `daily_rollup` already exists; no circular
  import — `ingest.js` doesn't import the WhatsApp pipeline).

No new migration and no new workflow in this phase.

## Reading the WhatsApp Updates Note

The day's gist lines live in `daily_rollup` where `kind='wa_updates'` and
`card_id='whatsapp'`. Each row is one date; its `entries` array holds one object
per Updates entity that had activity that day. This is the queryable "what did my
muted/bulk groups say today" surface, distinct from the Memory Notes that
Important and rerouted days produce.

## Verify

Validated end-to-end against a stubbed provider/DB across all four outcomes:

- quiet Updates group → **one** `wa_updates` gist entry, **zero** notes;
- Updates group with an urgent message → **no** gist, **rerouted** to facet notes,
  re-stamped `wa_tier='important'` (`updates-failsafe-urgent`);
- Updates group with an `@mention` → **no** gist, rerouted
  (`updates-failsafe-mention`);
- Important 1:1 → facet split, unchanged.

## What this unblocks

- **Phase 5**'s Kanban surfaces the two columns and, on an Updates→Important
  move, backfills past Updates days by re-running the facet-split path over them;
  the Important→Updates move switches new days to this gist path.
- The `daily_rollup` `wa_updates` rows are the data a future WhatsApp Updates
  dashboard view renders.
