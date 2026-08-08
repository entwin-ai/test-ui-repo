# Change — Babelscribe: GDrive audio → English transcript (translate + transcribe)

## What this adds
The **Babelscribe** connector card's **"Upload GDrive Audio Path"** button now
opens a modal that collects a Google Drive audio path and kicks off a
multi-lingual transcription + translation job. The audio is assumed to have
"anyone with the link" read access.

The result is a single **English** transcript. Any non-English speech (Hindi,
Bengali, Hebrew, …) is translated to English but wrapped in a language-tagged
bracket, e.g.

    Let's begin the meeting. [hi: Everyone please sit down.] Thank you all.

## Flow
1. **UI** (`app/page.tsx`) — clicking the button opens `BabelscribeModal`. The
   user pastes a Drive share link (`…/file/d/<id>/view`) or a bare file id.
2. **API** (`app/api/babelscribe/transcribe/route.ts`) — `POST` validates the
   input, extracts the Drive file id, and dispatches the workflow via the
   existing `dispatchWorkflow` helper (same mechanism as Gmail/WhatsApp).
3. **Workflow** (`.github/workflows/babelscribe-transcribe.yml`) — installs
   ffmpeg + Python deps and runs the worker.
4. **Worker** (`worker/babelscribe/transcribe.py`) — downloads the audio with
   `gdown` and runs **faster-whisper** (free, high-accuracy CTranslate2 Whisper)
   in two passes:
   - `task="transcribe"` (`multilingual=True`) to detect the language per
     segment;
   - `task="translate"` for the English output.
   The passes are aligned by timestamp; English segments print plain,
   non-English segments print as `[lang: english translation]`.
5. **Output** — `transcript.txt` (the deliverable) and `transcript.json`
   (structured segments) are uploaded as a workflow artifact
   (`babelscribe-transcript-<run_id>`).

## ML libraries (all free)
- `faster-whisper` — Whisper reimplementation; ~4× faster, lower memory, same
  accuracy. `large-v3` is the default (best accuracy); set `model_size` to
  `medium` on the dispatch for faster CPU runs.
- `gdown` — public Google Drive download.

## Config
No new secrets. Reuses the existing dispatch env:
- `GH_REPO` — `owner/repo`
- `GH_DISPATCH_TOKEN` — fine-grained PAT with Actions: read/write

## Notes / knobs
- GitHub-hosted runners are CPU-only; the worker uses `int8` so `large-v3`
  stays within time/memory budget. For long audio, dispatch with
  `model_size=medium` or move to a self-hosted GPU runner
  (`WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE=float16`).
- The workflow `timeout-minutes` is 90; raise it for very long recordings.

## Files
- `app/page.tsx` — `BabelscribeModal`, `babelscribeOpen` state, button wiring,
  modal render.
- `app/api/babelscribe/transcribe/route.ts` — dispatch route + Drive-id parser.
- `.github/workflows/babelscribe-transcribe.yml` — the job.
- `worker/babelscribe/transcribe.py` — the transcription/translation worker.
- `worker/babelscribe/requirements.txt` — Python deps.

---

## Update — bug fix + emailed PDF

### Fixed
`WhisperModel.transcribe()` has no `multilingual` argument in faster-whisper
1.0.3 (the earlier code passed it and crashed on pass 1). Per-segment language
is now identified from the **Unicode script** of the transcribe-pass text
(Devanagari→hi, Bengali→bn, Hebrew→he, Latin→en) — exact for these languages and
needs no extra model.

### Added — result emailed as PDF
- The worker now renders `transcript.pdf` (fpdf2) and emails it as an attachment
  to the **logged-in user** (`auth.email`, passed through as the workflow's
  `user_email` → `USER_EMAIL`). Email goes through **Resend**, the same provider
  the app already uses for Animatics.
- The workflow installs `fonts-dejavu-core` so any stray non-Latin glyphs render
  in the PDF.

### Config for the email step
- `RESEND_API_KEY` — repo **secret** (required to send). If unset, the job still
  completes and the PDF is available as the artifact; it just skips the email.
- `BABELSCRIBE_EMAIL_FROM` — optional repo **variable**, e.g.
  `Babelscribe <no-reply@yourdomain.com>`. Defaults to Resend's
  `onboarding@resend.dev` (fine for testing; use a verified domain for real
  delivery).

### Outputs now
`transcript.txt`, `transcript.pdf` (emailed + artifact), `transcript.json`.
