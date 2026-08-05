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

### Re-running (Connect / Disconnect)

The connector button toggles: **Connect** starts (or resumes) a run and turns
into **Disconnect** once a run exists. Clicking **Disconnect** calls
`/api/animatics/reset`, which deletes the job entirely — the job blob, every
stored headshot, and the owner index — so the next Connect begins a completely
fresh run from step 1. Inside the modal there's also a **↻ Start over** button
that does the same thing from ANY stage without closing the modal. Reset is
idempotent and owner-scoped.

## API routes (all under `/api/animatics/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `parse` | POST (multipart) | validate `.txt`, strip junk, create job — **LLM-free, instant** |
| `characters` | POST | extract the cast (separate, retryable step) |
| `headshot` | POST (multipart) | attach a headshot to one character |
| `screenplay` | POST | generate prose + shot list incrementally (call until `done`) |
| `document` | GET / POST | download `.docx` / save edited prose (rebuilds `.docx`) |
| `approve` | POST | re-parse edits into shot list, mark `APPROVED` |
| `status` | GET | current job state (resumes the UI after reload) |

### Why upload and extraction are split

Character extraction is a slow LLM call. If it runs *inside* the upload request
it can exceed the function timeout and return a 504
(`FUNCTION_INVOCATION_TIMEOUT`). So `parse` only cleans + stores the novel and
returns instantly; the client then calls `characters` (with automatic retry) to
extract the cast. The upload can never time out on the LLM.

## ⚠️ Vercel plan timeouts

`maxDuration` above **60 seconds requires Vercel Pro/Enterprise**. On the
**Hobby (free) plan every function is hard-capped at 60s** regardless of the
`maxDuration` value in the code. The routes are tuned to fit within 60s per
call:

- `parse` — no LLM, sub-second.
- `characters` — one small extraction call (novel is sampled, not read whole).
- `screenplay` — **one segment per call**; the client loops until done, so no
  single request needs more than one segment's worth of time.

If you are on Pro, you can raise `SEGMENTS_PER_CALL` in
`app/api/animatics/screenplay/route.ts` to process more segments per request.

## Environment

Reuses the app's existing config — no new variables required:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*`
  / `REDIS_REST_*` equivalents) — job storage.
- `ENTWIN_KEY_SECRET` — already used for LLM-key encryption.
- The user must have an LLM key saved under **Settings → LLM** (Claude, OpenAI,
  or Gemini). If not, the flow surfaces a clear "add a key" message.

## Notes / limits

- **Long / multi-episode novels are adapted in full.** The novel is split into
  ordered segments — by boundary markers when present, otherwise by size. Both
  full-word markers (`Episode 3`, `Chapter VII`, `Part Two`, Roman or Arabic,
  any case) and abbreviated forms (`E1:`, `EP 2`, `Ch. 4`, `S3:`, `#5`) are
  recognized. A repeated table-of-contents block at the top is detected and
  skipped so it doesn't create phantom segments. Each segment is generated
  separately and stitched, so a 10-episode novel yields a full 10-episode
  screenplay rather than just the first episode. **When the source labels its
  episodes/chapters, those exact headings are preserved in the screenplay** —
  each becomes a styled heading (teal, page break before) above that episode's
  scenes. Novels split only by size get no injected headings.
- Generation is robust to model output limits. Each episode is generated with a
  generous token ceiling, segments are size-bounded so a single response stays
  whole, and if a response is still truncated mid-JSON the parser **repairs** it
  (closing open strings/arrays/objects) to recover the complete elements the
  model emitted, rather than failing with a JSON error. A section that can't be
  parsed at all is noted and skipped instead of aborting the whole run.
- Generation runs **incrementally**: the screenplay route processes one segment
  per request, persisting progress to the job after each. The client re-calls
  until `done:true`, showing "part N/total". This keeps every request under the
  function timeout and makes generation **resumable** — a dropped request just
  continues from the last saved segment. Scene/shot numbers are offset per
  segment so they run continuously across the whole screenplay.
- Character extraction reads a head+tail sample of the novel (cheap) to find the
  cast; screenplay generation reads the whole novel via segmentation.
- The job blob holds base64 `.docx`; headshots are stored under separate Redis
  keys (kept out of the job blob so multi-character uploads stay small).
- Phase 2 (video/audio generation) consumes `job.shotList` — the structured
  contract this phase produces.
