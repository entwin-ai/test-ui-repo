-- 0022_whatsapp_drop_dead_source_url.sql
--
-- Defect fix: WhatsApp Memory Notes were being stamped with a wa.me/<number>
-- "source_url" that is NOT a citation to a specific message. In a browser tab
-- a bare wa.me/<number> just dead-ends on WhatsApp's "this link is not valid"
-- page (and for group / unsaved / non-WhatsApp numbers there is no target at
-- all). The reference chips in the Memory graph therefore all pointed at broken
-- links.
--
-- Going forward the WhatsApp pipeline writes source_url = NULL (see
-- worker/src/pipeline/whatsapp.js), and the UI renders a non-clickable
-- "<date> · WhatsApp" label for URL-less notes. This migration retroactively
-- clears the dead links already stored, so the fix applies without a full
-- re-ingest / graph rebuild.
--
-- Provenance is unaffected: each note still links back to its ledger row via
-- wa_message_id / source_ref.

UPDATE memory_note
SET source_url = NULL
WHERE source = 'whatsapp'
  AND source_url LIKE 'https://wa.me/%';
