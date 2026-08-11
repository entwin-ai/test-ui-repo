# Source hydration for chat RAG + memory mapping

Chat answers and the memory map previously drew only on the **distilled** memory
note (`raw_summary` → `note_chunk` → embedding). The model never saw the original
message, so it couldn't elaborate with specifics. This change makes retrieval
**hydrate the top matches with the verbatim source** — the actual WhatsApp/Slack
thread, email body, or Drive document passage — across all four connectors.

## What changed

**Retrieval stays the same.** Vector + keyword + recency search still runs over
the clean summary embeddings (relevance is unaffected). After retrieval, the top
**5** matched notes are hydrated from their raw source and the excerpt is appended
beneath the summary in the LLM context. The remaining matches still contribute
their summary.

**Three strategies, dispatched by `memory_note.source`** (`lib/rag/hydrate.ts`):

| Source | Strategy | Window |
|---|---|---|
| WhatsApp / Slack | follow FK to raw ledger, pull a conversation window | **±5 messages**, same `chat_id`/`channel_id` |
| Email | follow FK to `email_message`, use `clean_body` + subject/sender | one body (2k char cap) |
| Drive | `drive_file.extracted_text` (new), else neighboring `note_chunk` rows | file passage (2.5k char cap) |

**Isolation:** every hydration query carries `user_email` in its `WHERE` clause;
conversation/file ids read off a note are never trusted on their own.

**Token safety:** hydrate top-5 only, with per-source char caps; best-effort (a
source that errors is skipped, the answer still returns).

## Files

- `supabase/migrations/0024_drive_extracted_text.sql` — adds `drive_file.extracted_text` (persisted going forward; pre-existing rows fall back to note chunks).
- `supabase/migrations/0025_match_rpcs_return_source.sql` — `match_note_chunks_hybrid` and `match_entity_chunks` now also return `source` (needed for correct channel labels + per-source grouping). Arguments unchanged; column appended at the end.
- `lib/drive/ingest/pipeline.ts` — writes `extracted_text` on every Drive ingest (capped at 200k chars).
- `lib/rag/hydrate.ts` — **new** source-dispatched hydrator.
- `lib/rag/query.ts` — `ask()` and `askEntity()` hydrate top-5 and inject verbatim excerpts; updated system prompts; channel labels now cover Slack + Drive.
- `app/api/graph/evidence/route.ts` — **new** `GET /api/graph/evidence?entityId=…` returns the raw source behind an entity (memory-mapping evidence), reusing the same hydrator.

## Migration order

Apply `0024` then `0025`. Drive raw-text hydration only applies to files ingested
**after** `0024`; older files use the note-chunk fallback until re-ingested.

## Tuning knobs

In `lib/rag/hydrate.ts`: `CONVO_WINDOW` (±5), per-source char caps.
In `lib/rag/query.ts`: `HYDRATE_TOP_K` (5).
