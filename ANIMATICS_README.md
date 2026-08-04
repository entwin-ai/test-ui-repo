# Animatics — Phase 1 (Novel → Screenplay)

Phase 1 of the Animatics pipeline: turn an uploaded novel into an approved,
richly detailed screenplay, ready to hand to the Phase 2 video pipeline.

## Flow

Clicking **Connect** on the Animatics connector card opens a modal that walks
through:

1. **Novel** — upload a plain `.txt` file. Decorative junk (border lines,
   separator rules, box frames, page markers, ornament dividers) is stripped
   server-side; only meaningful prose is kept.
2. **Cast** — the LLM extracts the named characters. Upload one headshot per
   character (PNG/JPEG/WebP, ≤5 MB). These exact faces drive Phase 2.
3. **Screenplay** — the LLM writes a vivid screenplay (background, foreground,
   clothing colors, poses, expressions, camera framing, ambient sound) **and**
   a structured shot-list JSON in a single pass. You get a `.docx` to download,
   read, and edit inline.
4. **Approve** — on approval, any edits are re-parsed back into the shot list so
   the Phase 2 contract stays in sync. The job is marked `APPROVED`.

## Architecture

- **Frontend**: `app/animatics-flow.tsx` — a client modal state machine mounted
  in `ConnectorsView` (`app/page.tsx`). Resumes an in-progress job on open.
- **Parser**: `lib/animatics/parse.ts` — junk stripping (the core requirement).
- **Job store**: `lib/animatics/store.ts` — Upstash Redis, owner-scoped. The
  `.docx` and headshots are held base64 in the job blob (Phase-1 docs are
  small), so there is no separate object store to provision.
- **LLM**: `lib/animatics/pipeline.ts` — built on the app's existing
  `makeProvider` / `getLlmConfig`, so it uses the signed-in user's own LLM key
  from Settings. Lenient JSON parsing tolerates chatty model output.
- **DOCX**: `lib/animatics/docx.ts` + `lib/animatics/crc32.ts` — a
  zero-dependency `.docx` builder (a docx is a ZIP of OOXML; a tiny ZIP writer
  packs it). No new npm packages, so no added cold-start cost.

## API routes (all under `/api/animatics/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `parse` | POST (multipart) | validate `.txt`, strip junk, extract cast, create job |
| `headshot` | POST (multipart) | attach a headshot to one character |
| `screenplay` | POST | generate prose + shot list, build `.docx` |
| `document` | GET / POST | download `.docx` / save edited prose (rebuilds `.docx`) |
| `approve` | POST | re-parse edits into shot list, mark `APPROVED` |
| `status` | GET | current job state (resumes the UI after reload) |

## Environment

Reuses the app's existing config — no new variables required:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*`
  / `REDIS_REST_*` equivalents) — job storage.
- `ENTWIN_KEY_SECRET` — already used for LLM-key encryption.
- The user must have an LLM key saved under **Settings → LLM** (Claude, OpenAI,
  or Gemini). If not, the flow surfaces a clear "add a key" message.

## Notes / limits

- Long novels are clamped (head + tail) to stay within a single request's
  context window.
- The job blob holds base64 headshots + `.docx`; if you later expect very large
  casts or images, move those to object storage and keep only references here.
- Phase 2 (video/audio generation) consumes `job.shotList` — the structured
  contract this phase produces.
