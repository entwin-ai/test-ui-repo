-- ============================================================================
-- WhatsApp resolver identity (migration 0018).
--
-- Phase 6 of the WhatsApp Ingestion Read Me build plan (appendix: "Same-name and
-- number-change resolution order"). The shared Resolver (resolver.js) matches on
-- NAME, which is exactly wrong for WhatsApp's real ambiguity: a person keeps the
-- same display name but their NUMBER changes (new SIM, lost phone, business
-- migration). Name similarity must NEVER auto-place a genuinely new phone number
-- into pending_review (that produces noise, or worse a wrongful auto-merge).
--
-- This migration gives the entity row the two WhatsApp identity facts the
-- phone-first resolver needs, plus the review fields that let a human confirm a
-- number change by seeing BOTH numbers, not just a name:
--
--   entity.wa_phone            the phone number that keys this entity on WhatsApp
--   entity.wa_username         the durable WhatsApp username alias (if any),
--                              promoted from whatsapp_entity by the resolver ONLY
--                              when Phase 0 (0.2) confirmed it is account-tied
--   entity.wa_prev_phone       on a pending_review number-change candidate, the
--                              OLD number of the entity it might be merged into,
--                              so the Entity Review card shows both numbers
--
-- PURELY ADDITIVE: three nullable columns on the existing entity table. Nothing
-- else changes; email/slack entities simply leave them null.
-- ============================================================================

alter table entity
  add column if not exists wa_phone text;

alter table entity
  add column if not exists wa_username text;

-- On a pending_review entity that the resolver thinks is a NUMBER CHANGE of an
-- existing contact, this holds that existing contact's phone — so the reviewer
-- sees "old +1512… -> new +1737…" rather than just a name. Null for every other
-- kind of pending_review (name-based ambiguity keeps using merge_candidate only).
alter table entity
  add column if not exists wa_prev_phone text;

-- Look up an entity by its WhatsApp phone key fast (the resolver's step 0/exact
-- match). Partial index — only WhatsApp-keyed entities carry a wa_phone.
create index if not exists entity_wa_phone_idx
  on entity (user_email, wa_phone) where wa_phone is not null;

-- Look up by durable username alias (the resolver's auto-merge step 1).
create index if not exists entity_wa_username_idx
  on entity (user_email, wa_username) where wa_username is not null;

-- Force PostgREST to reload its schema cache immediately so the new columns are
-- visible to the API/worker layer without waiting for the periodic reload.
notify pgrst, 'reload schema';
