# Entwin RAG — additions to the v3.5 frontend

This layers a **standard RAG over Gmail** onto your existing Next.js app without
disturbing what already works. Auth, the Gmail OAuth/scan flow, WhatsApp, and the
UI are untouched except for one additive hook (fire ingestion after a scan) and
one additive cleanup (remove `sync_state` on disconnect).

## Architecture

```
Next.js app (Vercel)   existing OAuth + scan  +  NEW /api/gmail/ingest (dispatch)  +  NEW /api/ask (query)
GitHub Actions worker  1-yr backfill (on connect) + delta sync (cron) — reads Gmail tokens from Upstash Redis
Supabase (pgvector)    Memory Notes, daily rollups, vector chunks, sync cursors
LLMs                   Anthropic (write note + extract entities), OpenAI (embeddings)
```

Implements the Entwin **three-tier email flow** (ignore / storage / memory-worthy)
and the **Memory Note v4** anatomy. **Standard RAG only** — the entity-bubble /
wiki layer is not built yet, but `related_entities` is captured so it can be
added later with no re-parse.

## LLM: bring-your-own-key, provider-agnostic

Each user sets their own LLM provider + API key in the **Settings** page. The key
is stored **encrypted (AES-256-GCM) in Upstash Redis**, keyed by user email, and
is used for ALL LLM work for that user: email parsing (write note + extract
entities), the tier-2 updates summary, embeddings, and the `/api/ask` answer.

Supported providers (each does chat + embeddings): **Claude** (chat via
Anthropic, embeddings via Voyage), **OpenAI**, **Gemini**. The provider layer
(`worker/src/lib/provider.js` and `lib/rag/provider.ts`) is a single interface
with per-vendor adapters, so adding a provider is one adapter, not a pipeline
change. Embeddings from any provider are normalized to 1536 dims to fit the
fixed `vector(1536)` column.

Embedding model names are **config-driven** (not hardcoded): the worker and app
read `CLAUDE_EMBED_MODEL`, `OPENAI_EMBED_MODEL`, `GEMINI_EMBED_MODEL` from the
environment, falling back to current defaults (`voyage-3`,
`text-embedding-3-small`, `gemini-embedding-001`). If a provider renames or
retires an embedding model, change the env var — no code change. Set the same
values in Vercel and the GitHub `ingestion` environment.

The key is **write-only** from the browser's perspective: after saving, no
endpoint ever returns it. The app and worker share one secret,
`ENTWIN_KEY_SECRET`, used only to encrypt/decrypt these per-user keys — neither
holds any provider API key of its own.

## Isolation model

Users are identified by **Google email via NextAuth** (not Supabase Auth), so
isolation is enforced in the **service layer**: every Supabase query is scoped by
the session email, always taken from `getServerSession`, never from request
input. Defense in depth: RLS is enabled and FORCED on every table with no
anon/authenticated policies. Per-user LLM keys are isolated the same way — the
Redis key is derived from the user's email.

## What was added

New files:
- `supabase/migrations/0001_schema.sql` — tables keyed by `(user_email, card_id)`
- `supabase/migrations/0002_rls.sql` — RLS lockdown
- `supabase/migrations/0003_match_rpc.sql` — user-scoped vector retrieval RPC
- `worker/` — the GitHub Actions ingestion worker (reads tokens from Redis)
- `.github/workflows/backfill.yml` + `delta.yml`
- `lib/rag/supabase.ts` — server-only service-role client
- `lib/rag/query.ts` — embed → retrieve (scoped) → answer with Claude
- `app/api/gmail/ingest/route.ts` — registers `sync_state`, dispatches backfill
- `app/api/ask/route.ts` — the RAG query endpoint

Touched files (additive only):
- `app/page.tsx` — after a successful scan, POST `/api/gmail/ingest` (fire-and-forget)
- `app/api/gmail/disconnect/route.ts` — also delete the `sync_state` row
- `package.json` — add `@supabase/supabase-js`
- `.env.local.example` — add Supabase / LLM / GitHub-dispatch vars

## Setup

### 1. Supabase
Create a project; run `0001` → `0002` → `0003` in the SQL editor. Enable the
`vector` extension if not auto-enabled. Copy the project URL and service-role key.

### 2. Vercel env (add to existing)
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
ENTWIN_KEY_SECRET              # openssl rand -base64 32 — SAME value in the worker
GH_REPO, GH_DISPATCH_TOKEN     # fine-grained PAT, Actions: read/write
```
(You already have GOOGLE_*, NEXTAUTH_*, UPSTASH_REDIS_REST_*.)

### 3. GitHub Actions
Push the repo (private). Create an Environment named `ingestion` and add secrets:
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
ENTWIN_KEY_SECRET             # MUST match the app's value
```
The worker reads Gmail refresh tokens from the SAME Upstash Redis your app
already uses (identical key scheme), so no token migration is needed.

### 4. Flow
User connects a Gmail card (existing) → scan runs (existing) → app POSTs
`/api/gmail/ingest` → `sync_state` row created + backfill workflow dispatched →
worker backfills 1 year, then the delta cron keeps it fresh → user asks questions
via `/api/ask`.

## Caveats (unchanged from the design discussion)

- **GitHub cron is best-effort** — the 15-min delta can be delayed or skipped and
  auto-disables after 60 days of repo inactivity. For reliable freshness, drive
  `workflow_dispatch` from Supabase `pg_cron` or Trigger.dev/QStash; the workflow
  body stays identical.
- **Backfill on a large mailbox** may exceed the 6-hour job cap — it checkpoints
  `backfill_cursor` and resumes on the next run.
- **Reading many users' Gmail** triggers Google's restricted-scope verification
  and likely an annual third-party security assessment. Plan for it before real
  users.
- **Embedding egress**: email text goes to the user's chosen provider for
  embeddings. If content must stay in-house, add a local-embedding adapter in the
  provider layer.

## Wiki RAG (later)

`related_entities` is stored now. The Entity-file layer, Memory Note References,
bubble sizing, and the alias Resolver are the wiki-RAG scope and read from
`memory_note.related_entities` when you build them — no re-ingestion.


## Retrieval granularity: full-body chunks

The RAG layer embeds the **full cleaned email body**, not just the LLM summary.
Long bodies are split into overlapping ~2800-char chunks (`worker/src/lib/chunk.js`);
each chunk becomes one `note_chunk` row (incrementing `chunk_index`). The first
chunk is prefixed with a context header (sender/date/subject + summary) so a
match on it still has framing. This makes specific facts inside an email
retrievable, not only what the summary happened to capture.

At query time (`/api/ask`) `match_count` is 12 (a single email can span several
chunks), all retrieved chunks feed the LLM as context, and the **sources shown
to the user are deduped by email** so one message = one citation link.

Note: this increases embedding calls per email (one per chunk). If you re-parse
existing mail to pick up full-body chunks, clear old rows first (delete the
user's `email_message` rows with the reprocess query) and re-run the backfill.

## Wiki RAG + relationship graph (entity layer)

Built entirely from EXISTING data — no email is stored twice, nothing goes to
cloud drive. The raw material is `memory_note.related_entities`, already
captured at ingestion.

New pieces:
- **`entity`** table — one canonical row per resolved person/org (name, aliases,
  first/last seen). This is the identity layer the Resolver produces.
- **`entity_mention`** — join table (entity ↔ note); this is the v4 "Memory Note
  References" list and drives bubble size.
- **Resolver** (`worker/src/lib/resolver.js`) — deterministic alias matching:
  normalizes each related_entities string and either matches an existing entity
  or creates one. Runs live during ingestion AND as a one-shot backfill over
  notes you already have.
- **RPCs**: `entity_graph_nodes` (entities + bubble size), `entity_graph_edges`
  (co-occurrence edges), `match_entity_chunks` (entity-scoped wiki retrieval).
- **Routes**: `GET /api/graph` (nodes+edges), `POST /api/wiki` (entity-scoped
  answer). The Memory view renders the real graph; click a node for its wiki.

Setup:
1. Run `supabase/migrations/0004_entity_layer.sql`.
2. Build the entity layer from existing notes: Actions → **entity-backfill** →
   Run workflow. (No Gmail/LLM needed — pure DB transform. Add secrets
   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, already in the `ingestion` env.)
3. New ingestions populate entities automatically from then on.

Limitation: alias matching is deterministic (exact normalized-name match). It
merges case/spacing/email variants but not abbreviations ("S. Dasgupta" vs
"Subhankar Dasgupta") — the v4 "uncertain match → pending review" rule is not yet
implemented, by design, to avoid silently merging wrong.

## Backfill coverage fix + token usage display

**Window: last 1 year, consistently.** Both the scan (`lib/gmail/service.ts`
windowQuery) and the worker backfill (`worker/src/index.js` runBackfill) compute
"one year ago" the same way and format it as Gmail's `after:YYYY/MM/DD`. This is
the single source of the earlier mismatch's fixes:
  - the backfill previously used `after:<raw epoch>` (unreliable, dropped
    results) and no label filter; it now uses the same YYYY/MM/DD date and
    enumerates INBOX + SENT as two label passes, matching the scan.
  - a message in both labels is de-duped by the ledger's unique
    (user_email, gmail_msg_id).
  - backfill_cursor encodes `LABEL:pageToken` so a run that hits the time cap
    resumes across both labels.

Note: Gmail's search listing is thread/conversation-indexed, so the parsed count
can differ from a label's raw total by a small margin — but scan and backfill now
report the same 1-year window.

**Token usage on screen:** `GET /api/usage` aggregates llm_cost_log (one row per
LLM call, all providers) into total input/output tokens plus a per-call-kind
breakdown. Dashboard → Overview shows live "Input Tokens" / "Output Tokens"
cards that refresh every 15s while a backfill runs.

## Performance: concurrency, backoff, merged call, batched embeddings

Four changes cut backfill wall-clock time dramatically (the job was
API-latency-bound, processing one email at a time):

1. **Bounded concurrency** (`worker/src/lib/pool.js`) — the backfill/delta now
   process ~6 emails in parallel (tune with the `INGEST_CONCURRENCY` repo
   variable; default 6). Since the runner was idle waiting on API responses,
   this alone is a large speedup.
2. **Retry with backoff** (`worker/src/lib/retry.js`) — every LLM/embed call
   retries on 429/5xx with exponential backoff, honoring Retry-After. A rate
   limit now waits-and-retries instead of dead-lettering the email. This both
   fixes the 429 failures and makes concurrency safe near the provider ceiling.
3. **Merged LLM call** — write-note and extract-entities are now ONE request
   (`writeNoteAndEntities`) returning both the note fields and related_entities,
   halving per-email LLM latency. Cost log kind is `write_note_and_entities`.
4. **Batched embeddings** — all of an email's body chunks are embedded in ONE
   `embedBatch` request (arrays: OpenAI/Voyage input arrays,
   Gemini batchEmbedContents), then bulk-inserted, instead of one call per chunk.

Concurrency safety: note_id now carries a random suffix so parallel notes on the
same date can't collide on the unique constraint.

Tuning: if you still see 429s, lower `INGEST_CONCURRENCY` (repo → Settings →
Secrets and variables → Actions → Variables). If your provider has generous
limits (OpenAI), you can raise it (8–10) for more speed.

## Hybrid retrieval (keyword + vector + recency)

Pure vector search misses exact keywords (e.g. "RSVP") and ignores recency, so
questions like "what's the ask of the latest RSVP email" retrieved
semantically-near but wrong notes. `match_note_chunks_hybrid`
(migration 0005) blends three signals:
  - vector similarity (semantic)
  - full-text keyword match on chunk content (rescues exact terms; GIN index)
  - recency (0..1, newest highest), boosted when the question contains
    latest/recent/last/newest/current.

`ask()` detects recency intent, calls the hybrid RPC with the raw query text,
orders context newest-first for recency queries, and tells the model to prefer
the newest relevant note. Setup: run `supabase/migrations/0005_hybrid_retrieval.sql`.
The old match_note_chunks RPC is left in place (unused by the app now).
