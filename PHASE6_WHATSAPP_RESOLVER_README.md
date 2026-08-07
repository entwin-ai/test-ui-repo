# Phase 6 — WhatsApp resolver ordering (same-name / number-change)

Phase 6 implements the WhatsApp Ingestion Read Me appendix: the resolution order
for a phone number the system hasn't seen before. The shared resolver matches on
**name**, which is the wrong key for WhatsApp — a display name that merely looks
like someone already on file must never, by itself, merge or flag a genuinely new
number. WhatsApp's identity key is the **phone number**; the real ambiguity is a
**number change** (same person, new SIM / lost phone / business migration). This
phase adds a phone-first resolver for 1:1 contacts and surfaces the two-number
detail on the Entity Review queue.

This phase is independent of Phases 2–5 and depends only on Phase 1 (which
captured `wa_username` / `username_is_durable`) and the Phase 0 durability verdict
(0.2), which gates the username auto-merge step.

## Resolution order (`worker/src/lib/wa-resolver.js`)

For a 1:1 contact, `resolveWhatsappContact` resolves by phone in strict order:

0. **Exact phone match** → that entity. The everyday case; short-circuits
   everything below.
1. **New number, durable username matches** an existing entity's username alias
   → **auto-merge** at exact-match confidence, no review. The username travels
   with the account, not the number, so it's a stronger signal than context.
   **Gated on durability**: only a username Phase 1 flagged
   `username_is_durable` (i.e. the Phase 0 0.2 verdict was `durable`) may
   auto-merge. A text-only username degrades to the fuzzy band.
2. **New number, no durable username, strong full-name match** → **new
   provisional entity, `pending_review`**, carrying `merge_candidate` and — the
   Phase 6 addition — **both phone numbers** (`wa_prev_phone` = the old number,
   `wa_phone` = the new one) so a human confirms a number change, not just a name.
3. **Neither** → **clean new entity.** A never-seen number with no username and no
   strong name match is a new person — never `pending_review` on name alone.

### §6.1 — no first-name coincidences

The number-change judgment uses a **jaccard-dominant** name scorer (0.8 jaccard /
0.2 containment, threshold 0.8), deliberately unlike the shared resolver's
containment-friendly blend. This is what stops a new number named "Alice" from
being flagged against an existing "Alice Smith": a single shared first-name token
against a two-token name scores 0.5 and does not clear the bar. Only a strong,
mutual full-name overlap makes a new number a number-change candidate. Validated
by unit tests, including this exact negative case.

## What was added / changed

**Schema — `supabase/migrations/0018_whatsapp_resolver_identity.sql`:**
- `entity.wa_phone`, `entity.wa_username` — the WhatsApp identity facts the
  phone-first resolver keys and auto-merges on, with partial indexes.
- `entity.wa_prev_phone` — on a number-change `pending_review` candidate, the old
  number, so the review card shows both.

**Worker:**
- `worker/src/lib/wa-resolver.js` (new) — the phone-first ordering above.
- `worker/src/lib/resolver.js` — exports `recordResolvedEntity`, to attribute a
  note to an already-resolved (phone-keyed) entity with the same idempotent
  mention + note-ownership bookkeeping as the name path.
- `worker/src/pipeline/whatsapp.js` — for a 1:1 entity-day, resolves the contact
  by phone once (loading `wa_username` / `username_is_durable` from
  `whatsapp_entity`) and attributes every facet note that day to it, in addition
  to the name-resolved `related_entities`. Groups/communities are not a single
  person and are unaffected.

**Dashboard — `app/api/entities/review/route.ts` + `app/page.tsx`:**
- The Pending Review queue now returns and renders both phone numbers on a
  number-change card ("Possible WhatsApp number change: +1512… → +1737…"), and
  the merge button reads "Confirm same person" for that case. The underlying
  merge/reject actions are unchanged — a number-change confirmation is just the
  existing merge.

## Verify

- All worker files pass `node --check`; the review route and page changes are
  type-clean (only the repo-wide missing-`node_modules` `tsc` noise remains).
- The resolver was validated by 7 unit assertions covering every branch: exact
  phone re-match, durable-username auto-merge, the §6.1 first-name-coincidence
  negative (new entity, not pending), and the full-name number-change
  (pending_review carrying both numbers and the merge candidate).

Deploy: apply `0018`, deploy the worker and app. The auto-merge step only fires
where `username_is_durable` is true, so it stays dormant until the Phase 0 probe
confirms durability and Phase 1 captures a durable username — matching the Read
Me caveat that step 1 must be verified against the real ingestion layer before
being trusted.

## Note on the caveat

If the Phase 0 0.2 verdict is `text_only` (username is editable display text with
no stable backing id), the auto-merge step never fires — every such username is
treated as a fuzzy signal only, exactly as the Read Me requires. No code change is
needed for that outcome; it's data-driven by `username_is_durable`.
