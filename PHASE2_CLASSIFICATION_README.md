# Phase 2 — WhatsApp tier classification (Ignore / Updates / Important)

Phase 2 adds the decision layer: every WhatsApp entity is placed in exactly one
of the three outcomes from Read Me §3 — **Ignore**, **Updates**, or
**Important** — by the deterministic rules in §4–5. It reads the entity metadata
Phase 1 captured and produces a tier; it does **not** yet build the Updates gist
note or the Important facet-split (those are Phases 3–4). What it guarantees now:
archived entities are dropped (Ignore produces nothing), and every entity is
recorded so the Phase 5 Kanban has data.

## The model: computed-live, not cached

WhatsApp's tier is mostly a **deterministic function of live metadata**
(archived, muted, member_count, self-admin, community-admin) that Phase 1
refreshes into `whatsapp_entity` every run. Caching a tier would go stale the
moment a group is muted or archived, so the classifier **recomputes** it live
each run. The new `whatsapp_classification` table stores only what is *not*
derivable from live metadata:

1. a **manual override** — the user dragged the entity between Kanban columns
   (wins over the computed default, except archived still wins over everything);
2. a **provisional bootstrap** placement recorded at first sight, so a brand-new
   entity shows on the Kanban immediately.

There is deliberately **no `ignore` value** in the table: Ignore *is* the
archived state, read live and treated as absolute (Read Me §4). A user can't pin
a chat to Ignore — they unarchive in WhatsApp itself. The two stored tiers mirror
the two Kanban columns exactly (Read Me §7).

## The cascade (strict order — `wa-classification.js` `computeTier`)

1. **archived → Ignore** — absolute, first, every entity type incl. 1:1. Beats
   admin and manual.
2. **manual override → that tier** — applied by the entry function after the
   archived check.
3. **admin exception → Important** — overrides mute *and* size (Read Me §5). For
   a subgroup, admin cascades from the parent community.
4. **Updates triggers → Updates** — any one of: muted; more than 10 members;
   sits under a community where the user is not admin (cascades to all its
   subgroups).
5. **default → Important** — 1:1 contacts, and any group not caught above.

**`null` means "unknown", not "false"** (the Phase 1 contract). An unknown admin
state does not fire the admin exception; an unknown member_count does not trip
the >10 rule; unknown mute/archived are treated as not-muted / not-archived. This
is the Phase 0 decision-record fallback — it keeps an unreadable field from
silently promoting or hiding an entity. The one place it surfaces on the Kanban:
a group whose tier hinged entirely on unknowns is written `confirmed = false` so
the user is asked to confirm it, whereas a placement resting on readable facts is
`confirmed = true` at bootstrap (unlike email, which is provisional by default —
Read Me §7).

The cascade is covered by 20 unit assertions (every rule, both community-admin
cascade paths, the 10-vs-11 boundary, and each null case).

## What was added / changed

**Schema — `supabase/migrations/0017_whatsapp_classification.sql`:**
- `whatsapp_classification` — the manual-override + bootstrap store, keyed to
  `identity_key` (same stable key as `whatsapp_entity`), tier ∈ {updates,
  important}, `confirmed`, `source` ∈ {bootstrap, manual}, `bootstrap_reason`.
- `wa_tier` / `wa_tier_reason` on `whatsapp_message` — observability, so a run's
  routing is auditable ("why no note? → archived") without recomputing.

**Worker:**
- `worker/src/lib/wa-classification.js` (new) — `computeTier` (pure cascade),
  `classifyWhatsappEntity` (the Phase 2.4 entry: archived → manual → computed,
  records bootstrap), and `classifyMany` (batched, for Phase 3).
- `worker/src/pipeline/whatsapp.js` — classifies each message's entity before any
  LLM work. **Ignore-tier (archived) rows are dropped**: marked processed, no
  note, no LLM call (Read Me §4). Updates and Important both still flow through
  the existing note path for now — the Updates gist and Important facet-split
  arrive in Phases 3–4. The resolved tier is stamped on each processed row.

## Deploy

1. Apply `0017_whatsapp_classification.sql` (additive).
2. Deploy the updated `worker/`. The next `whatsapp-sync` run classifies every
   entity, stops writing notes for archived chats, and populates
   `whatsapp_classification` for the Kanban. Verify by inspecting that table
   (each entity has a tier + reason) and `whatsapp_message.wa_tier`.

Ordering note: Phase 2 reads `whatsapp_entity`, so run at least one post–Phase-1
sync first (or the same run — capture writes entities before vectorize reads
them). If `whatsapp_entity` is empty, every entity falls to the `important`
default and nothing is lost.

## What this unblocks

- **Phase 3** calls `classifyMany` to route each entity-day: Important → facet
  split, Updates → gist, Ignore → skip.
- **Phase 4** builds the Updates gist note + failsafe on the `updates` tier.
- **Phase 5** reads `whatsapp_classification` (tier, confirmed, reason) for the
  two-column Kanban and writes `source='manual'` on a drag.
