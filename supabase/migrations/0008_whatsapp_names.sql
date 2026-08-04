-- ============================================================================
-- WhatsApp name resolution + group flag (migration 0008).
--   1. sender_name / chat_name are resolved through a per-run name registry
--      (contacts + chat/group subjects) instead of the last speaker's pushName;
--      capture UPDATEs those columns on re-upsert as names become known.
--   2. Add is_group so downstream can distinguish a group chat from a 1:1.
-- ============================================================================

alter table whatsapp_message
  add column if not exists is_group boolean not null default false;

update whatsapp_message
  set is_group = (chat_id like '%@g.us')
  where is_group is distinct from (chat_id like '%@g.us');

create index if not exists whatsapp_message_chat_ts_idx
  on whatsapp_message (user_email, chat_id, msg_timestamp);

-- Force PostgREST to reload its schema cache immediately so the new column is
-- visible to the API layer without waiting for the periodic reload (the
-- "Could not find the 'is_group' column ... in the schema cache" symptom).
notify pgrst, 'reload schema';
