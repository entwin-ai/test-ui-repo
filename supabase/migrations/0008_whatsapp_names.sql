-- ============================================================================
-- WhatsApp name resolution + group flag (migration 0008).
--
-- Two capture improvements are backed by this migration:
--   1. sender_name / chat_name are now resolved through a per-run name registry
--      (contacts directory + chat/group subjects) instead of the last speaker's
--      pushName. No schema change is needed for that — sender_name and chat_name
--      already exist — but capture now UPDATEs those columns on re-upsert as
--      names become known, so this migration documents the intent.
--   2. Add is_group so downstream (vectorize, UI) can distinguish a group chat
--      from a 1:1 without re-parsing the jid.
-- ============================================================================

alter table whatsapp_message
  add column if not exists is_group boolean not null default false;

-- Backfill the flag for any rows already captured (group jids end in @g.us).
update whatsapp_message
  set is_group = (chat_id like '%@g.us')
  where is_group is distinct from (chat_id like '%@g.us');

-- Helpful for chat-scoped lookups / per-chat history checks.
create index if not exists whatsapp_message_chat_ts_idx
  on whatsapp_message (user_email, chat_id, msg_timestamp);

-- Force PostgREST to reload its schema cache immediately so the new column is
-- visible to the API layer without waiting for the periodic reload (this is the
-- "Could not find the 'is_group' column ... in the schema cache" symptom).
notify pgrst, 'reload schema';
