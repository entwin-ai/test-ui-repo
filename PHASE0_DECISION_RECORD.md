# Phase 0.4 — Decision record (WhatsApp open policy items)

Four items in the WhatsApp Ingestion Read Me are left deliberately open as
"engineering / product considerations." They are **policy calls, not code**, and
each **blocks a specific downstream requirement**. This record states each one,
its dependency, a recommended default (with rationale), and a status field the
product owner flips from **Proposed** to **Decided**.

Phase 1+ should not build the dependent requirement until the corresponding row
here reads **Decided**.

---

## D1 — Admin-over-mute/size precedence

- **Read Me ref:** §5 (Admin exception), §10.
- **Blocks:** Phase 2.2 rule ordering.
- **Question:** Does "any group or community I administer gets a full Memory
  Note" override the mute and >10-members Updates triggers? (Archived still wins
  over everything — that part is not in question.)
- **Recommended default:** **Yes — admin overrides mute and size, but not
  archived.** This is the document's own read of the instruction; it makes admin
  status a deliberate signal of importance that a large member count shouldn't
  demote. Evaluation order in Phase 2.2: `archived → admin → updates-triggers →
  default`.
- **Rationale:** An admin of a group has explicitly taken responsibility for it;
  size/mute are weak importance signals by comparison. Making admin win keeps
  the rule legible ("I run it, so I see it in full").
- **Status:** _Proposed_ → **[ ] Decided by: ______  date: ______**

## D2 — Username durability (ties into 0.2)

- **Read Me ref:** appendix ("Caveat, not an assumption to build against yet").
- **Blocks:** Phase 1.3 (store username as alias) + Phase 6.2.1 (username
  auto-merge at exact-match confidence).
- **Question:** Is the WhatsApp username exposed with a stable, account-tied
  backing identifier, or only as editable display text?
- **How decided:** This one is **answered by the probe (0.2)**, not by opinion.
  Record the probe's `username_durability` verdict here and the resulting call:
  - `durable` → build 6.2.1 as specified; use `username_field_path` as the alias
    key in 1.3.
  - `text_only` → **do not** build 6.2.1; the username becomes at most a fuzzy
    signal, and the changed-number case relies on `pending_review` only.
  - `unknown` → re-probe against an account with a username set before deciding.
- **Probe verdict recorded:** ____________  **Resulting call:** ____________
- **Status:** _Proposed_ → **[ ] Decided by: ______  date: ______**

## D3 — Ignore-tier audit trail

- **Read Me ref:** §4, §10.
- **Blocks:** Phase 4.4 (what an archived entity-day writes).
- **Question:** Email's Ignore/Marketing tier logs one line per message to the
  Ignored Daily Emails Note. Should the WhatsApp Ignore tier (archived entities)
  similarly log a rollup line, or write **nothing at all**?
- **Recommended default:** **Nothing at all.** Take the Read Me's "no notes at
  all" literally: no Memory Note, no gist, no rollup for an archived entity.
- **Rationale:** Archiving is an explicit user signal of "I don't want to see
  this." A hidden audit rollup partly defeats that, and email's parallel exists
  mainly because marketing mail is unsolicited — archived chats are the user's
  own deliberate choice. If observability of "what got skipped" is later wanted,
  it can be derived from the ledger without a stored rollup.
- **Status:** _Proposed_ → **[ ] Decided by: ______  date: ______**

## D4 — Unarchiving backfill

- **Read Me ref:** §4, §10.
- **Blocks:** a Phase 5 follow-on (not yet a numbered requirement, precisely
  because this is undecided).
- **Question:** When an entity is unarchived, is the coverage gap from while it
  was archived **backfilled** (create notes for those past days), or left as a
  **permanent gap** in that entity's Memory Note References?
- **Recommended default:** **Permanent gap (no backfill).** While archived the
  entity produced nothing by design; on unarchive, resume forward coverage only.
- **Rationale:** Backfilling contradicts the intent of the archive period ("I
  didn't want these tracked") and, unlike a Kanban move, there is no explicit
  user action to hang a backfill decision on. It is also the cheaper, simpler
  behavior. If a user genuinely wants the history, a **manual** Updates→Important
  style backfill (Phase 5.3) can be offered as an explicit opt-in rather than
  happening automatically on unarchive.
- **Status:** _Proposed_ → **[ ] Decided by: ______  date: ______**

---

### Also depends on the probe, not on this record

Beyond D2, any 0.1 metadata field the probe reports as **not available** forces
a fallback decision for the Phase 2 rule that consumes it (e.g. if self-admin
state can't be read, the admin exception D1 can't fire and every large/muted
group falls to Updates). Record any such fallback here as it arises:

- _e.g._ `self_admin_available = no` → admin exception disabled; treat all
  groups by mute/size only. **Call:** ____________

### Sign-off

Phase 0 is complete when D1–D4 all read **Decided** and the probe exit criteria
in `PHASE0_CAPABILITY_PROBE_README.md` are met.
