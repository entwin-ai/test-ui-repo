# Google Drive Ingestion — Change README

Implements the **Google Drive Ingestion Rules: Read Me (v1, 2026-08-01)**:
connecting **Google Drive — Personal** now reads the files in the folders the
user selects and turns them into Memory Notes that flow into the same
cross-channel entity graph and retrieval index as Gmail / Slack / WhatsApp.

## User-facing flow

1. **Connect** (`drive-personal` card) → read-only Google OAuth
   (`drive.readonly`, reuses the existing Google client).
2. **Pick folder(s)** in the Drive Explorer → saved as ingestion roots
   (Read Me §1 Scope — only selected folders are ever read).
3. **First-connection ingestion** runs immediately: every file read in full →
   Memory Notes (Read Me §1).
4. **Read Now** (settings modal) → out-of-cycle **forced-refresh** diff scan.
5. **Daily scan** → recurring, unattended (see *Scheduling* below).
6. **Disconnect** drops the token + this card's diff ledger + its scan schedule,
   but does **not** delete already-written notes (that's "Kill My Twin").

## What maps where (Read Me → code)

| Read Me | Code |
| --- | --- |
| §1 cadence, once-per-day gate, historical dating | `lib/drive/ingest/rules.ts` |
| §2 Resolver (3 outcomes), note persistence | `lib/drive/ingest/resolver.ts` |
| §3 per-type extraction (Word/PPT/Excel-per-tab/PDF/image) + vision | `lib/drive/ingest/extract.ts` |
| §4 large-file per-page/slide split, audit trail, cross-page edges | `rules.ts` + `pipeline.ts` |
| end-to-end orchestration | `lib/drive/ingest/pipeline.ts` |
| §5 open items (thresholds) | env-overridable constants in `rules.ts` |

## API routes

- `GET  /api/drive/authorize?card=drive-personal` — read-only OAuth handoff.
- `GET  /api/drive/callback` — token exchange (existing route; now scope-aware).
- `POST /api/drive/select-ingest` — save selected folder(s) as ingestion roots.
- `POST /api/drive/ingest` — register `sync_state` + **dispatch `drive-ingest.yml`**
  (first-connect); in-process fallback if Actions aren't configured.
- `POST /api/drive/scan-all` — **workflow/cron target**; runs the pipeline for
  due (or scoped/forced) users.
- `POST /api/drive/disconnect` — drop token + ledger + schedule for the card.

## Scheduling & jobs (GitHub Actions)

Two workflows, both **visible in the Actions tab**:

- **`drive-ingest.yml`** — *first-connect ingestion*. Dispatched by
  `POST /api/drive/ingest` when the user finishes picking folders (the same way
  Gmail's connect dispatches `calibrate.yml`). It reads every file in full →
  one Memory Note per file (Read Me §1). Dispatch-only, scoped per user.
- **`drive-scan.yml`** — *recurring daily scan*. Fires hourly on a cron and runs
  the diff-based scan for any user whose `pollHours` has elapsed.

Both are thin, visible triggers that POST the app's `/api/drive/scan-all`
endpoint (Drive's pipeline lives in the app, not `worker/`, so the workflow
calls back into the app rather than running worker code). `scan-all` is a
**heartbeat + per-user cadence gate**: it enumerates `sync_state` rows with
`channel='drive'` and runs each due user. A `first-connect` / `forced-refresh`
dispatch bypasses the cadence gate (runs immediately); the plain cron tick
honors each user's `pollHours`.

**Fallback:** if `GH_REPO` / `GH_DISPATCH_TOKEN` are not configured (e.g. local
dev with no Actions), `POST /api/drive/ingest` runs the pipeline in-process
instead of dispatching, so the feature still works — the response says
`ranInProcess: true` vs `dispatched: true`.

### Required config

Server env **and** GitHub repo secrets:

- `CRON_SECRET` — long random string; must match on both sides.
- `APP_BASE_URL` (repo secret) — where the workflow calls, e.g.
  `https://your-app.vercel.app`.

Optional tuning: `DRIVE_LARGE_FILE_PAGE_THRESHOLD` (default 40),
`DRIVE_EXCEL_ENTITY_CAP` (default 25).

## Data model

- `supabase/migrations/0021_drive_ingestion.sql`
  - `drive_file` — per-file diff ledger (content hash + Drive modifiedTime /
    version / md5 + `last_note_date` + `note_count` + `is_large`); the change
    detector for the daily scan.
  - `memory_note.drive_file_id` / `drive_facet` / `drive_note_kind` — which file
    and which page/slide/tab a note came from.
  - Reuses existing `sync_state.channel` (`'drive'`), `last_delta_at`, and the
    whole `memory_note` / `note_chunk` / `entity` / `entity_mention` /
    `note_ownership` pipeline.

## Teardown

`drive_file` is added to **Kill My Twin** (`lib/twin/teardown.ts`) so deleting a
twin wipes the Drive diff ledger too; notes/entities were already covered.

## Notes / limitations

- `drive.readonly` is a Google **restricted** scope — production external use
  needs consent-screen verification (same trade-off as the existing Chorale
  write flow).
- Ingestion makes real LLM/vision/embedding calls, so a per-user LLM key must be
  configured in Settings first.
- OOXML is parsed directly via `fflate` (already a dependency) — no new parser.
  PDF text extraction is best-effort/gist-level by design (the original file
  stays the source of truth); scanned pages go to the vision model, not OCR.
- Video is parked (Read Me §3) until a video-capable model is identified.
