-- ============================================================================
-- Drive raw-text hydration (migration 0024).
--
-- Motivation: chat RAG and memory mapping answer from the DISTILLED memory note
-- (memory_note.raw_summary -> note_chunk -> embedding). For email, WhatsApp and
-- Slack we can hydrate an answer with the VERBATIM source at query time by
-- following memory_note's FK back to the raw ledger row (email_message.clean_body,
-- whatsapp_message.body, slack_message.body). Drive was the one gap: the
-- drive_file ledger stored only hashes + metadata, never the extracted document
-- text, so a Drive-sourced answer could never be elaborated from source.
--
-- This migration adds drive_file.extracted_text: the concatenated per-facet
-- extracted text the ingestion pipeline already computes (extracted.units'
-- facet + bodyText), persisted GOING FORWARD so the hydrator can pull the
-- surrounding document passage for a matched Drive chunk. Nullable: rows
-- ingested before this migration (and unreadable/metadata-only notes) leave it
-- null, and the hydrator falls back to pulling extra note_chunk rows for those.
--
-- Keyed like everything else by (user_email, card_id, file_id); isolation is
-- enforced in the service layer (every query carries user_email).
-- ============================================================================

alter table drive_file
  add column if not exists extracted_text text;   -- verbatim extracted text (facet-joined), null pre-0024

comment on column drive_file.extracted_text is
  'Verbatim extracted document text (per-facet units joined), persisted for '
  'query-time hydration of Drive-sourced answers. Null for rows ingested before '
  'migration 0024 and for unreadable/metadata-only files; the hydrator falls '
  'back to neighboring note_chunk rows in those cases.';
