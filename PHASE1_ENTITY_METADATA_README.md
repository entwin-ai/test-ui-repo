# Phase 1 — WhatsApp per-entity metadata & identity foundation

Phase 1 lays the data foundation every later WhatsApp phase reads from. The tier
classifier (Phase 2), the Kanban (Phase 5), and the resolver's WhatsApp ordering
(Phase 6) all decide against **entity-grained** facts — per contact, group, or
community — that the current pipeline never captured. This phase captures and
persists them. It ships **no** classification, routing, facets, or UI; those are
later phases. It is purely additive and does not change the existing
capture/vectorize behavior.

Phase 1 depends on the Phase 0 probe having confirmed these fields are actually
exposed by the ingestion layer. Where the probe came back `text_only` or
`UNCONFIRMED`, the corresponding field is still captured but treated as
best-effort — see "Nulls are 'unknown'" below.

## What was added

**Schema — `supabase/migrations/0016_whatsapp_entity_metadata.sql`:**

- **`whatsapp_entity`** — one row per WhatsApp entity, keyed by a stable
  `identity_key` (phone number for a person; group id / community id for a
  group / community — **never** display name, per Read Me §2). Holds the live +
  structural metadata Phase 2 reads: `wa_entity_type` (`person|group|community`),
  `muted`, `member_count`, `is_admin`, `archived`, `community_id` (parent
  community for a subgroup), and `community_is_admin`. A trigger stamps
  `metadata_updated_at` only when a live field actually changes.
- **`wa_username` / `username_is_durable`** on that table — the WhatsApp
  username stashed as reference data for the resolver to promote into
  `entity.aliases` in Phase 6 (Read Me §2: a secondary alias, never the identity
  key). `username_is_durable` records whether the value looked like a stable,
  account-tied identifier (an `@lid` or a handle) versus editable display text.
- **`wa_entity_type` / `community_id`** added to `whatsapp_message` so a captured
  message already carries the three-way discriminator downstream without a join
  (extending what `is_group` from 0008 did). Historical rows are backfilled to
  `person`/`group` from `is_group`; community-vs-group is only known from group
  metadata, so existing group rows stay `group` until re-captured — never guessed.

**Capture — `worker/src/lib/wa-entities.js` (new) + `whatsapp-capture.js`:**

- A per-run, in-memory **entity metadata registry** (the metadata sibling of the
  existing `wa-names.js`). It harvests from the same Baileys events capture
  already listens to — `messaging-history.set`, `chats.upsert`, `chats.update`
  (the live archived/muted flip signal), `contacts.*`, and `groups.upsert` — and
  at end-of-run hands capture a flat list of entity rows.
- `whatsapp-capture.js` now feeds that registry alongside the name registry,
  stamps each message row's `wa_entity_type` / `community_id` from it, and
  upserts the entity rows into `whatsapp_entity` in `finish()`. The upsert is
  **best-effort and isolated** — a metadata failure never fails message capture —
  and is resilient to a not-yet-reloaded schema cache the same way the message
  upsert is.

## Nulls are "unknown", not "false"

Every live metadata field is nullable, and the collector writes `null` (not a
default) when the ingestion layer didn't surface it this run. This is deliberate:
Phase 2 must apply the Phase 0 decision-record fallback for an unknown value
(e.g. unknown admin state → treat as non-admin) rather than acting on a wrong
guess. Do not "helpfully" default these to `false` in Phase 2 — the distinction
between "known false" and "unknown" is load-bearing for the admin exception.

## Deploy

1. Apply `0016_whatsapp_entity_metadata.sql` (additive; nothing else changes).
2. Deploy the updated `worker/` tree. The next `whatsapp-sync` run populates
   `whatsapp_entity` and the new message columns automatically — no new workflow,
   no new secrets. The run log now reports an entity count, e.g.
   `capture done (quiet) — 42 rows, 7 chats, 7 entities, names[…]`.
3. Nothing consumes `whatsapp_entity` yet — that's Phase 2. Verify Phase 1 by
   inspecting the table after a sync: each 1:1 should be `person` with a phone
   `identity_key`; groups/communities should carry `member_count`, and where you
   administer one, `is_admin = true`.

## What this unblocks

- **Phase 2** reads `whatsapp_entity` to place each entity in Ignore / Updates /
  Important by the deterministic rules (Read Me §4–5).
- **Phase 6** reads `wa_username` / `username_is_durable` to decide username
  auto-merge vs. fuzzy-band `pending_review`.
- **Phase 5** shows `is_admin` / `muted` / `member_count` on each Kanban card.
