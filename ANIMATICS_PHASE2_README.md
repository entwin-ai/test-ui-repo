# Animatics — Phase 2 (Video render via Google Colab)

Phase 2 turns an APPROVED screenplay (Phase 1's shot list + headshots) into a
single MP4, uploads it to Google Drive, and emails the download link.

## Architecture

```
Next.js app (Vercel)                     Google Colab notebook (GPU)
────────────────────                     ───────────────────────────
User approves screenplay
  → clicks "Generate video"
  → POST /api/animatics/render
  → job enqueued (RENDER_QUEUED)

                              ← POST /api/animatics/render/claim
                                 (worker token) → returns shotList +
                                 headshots (data URLs) + characters
                              → RENDERING

                                 Renders with the open ML stack:
                                   Kokoro TTS (audio-first)
                                   Wan VACE + headshot refs (mute video)
                                   InsightFace swap (optional)
                                   ffmpeg merge (audio-first)
                              → POST /api/animatics/render/progress (repeatedly)

                                 Uploads MP4 to Google Drive (Colab mounts
                                 Drive natively) → shareable link
                              → POST /api/animatics/render/complete
                                 { driveLink, driveFileId }

  → RENDER_DONE
  → emails the link to the job owner
  → link also shown in the modal
```

The app **orchestrates and stores**; Colab does the **GPU work**; they talk over
the render queue in Redis. Nothing long-running runs on Vercel.

## The ML pipeline (adapted from `story_to_movie_faces.py`)

All models are free / open-weight. The one paid piece from the original program
— the Gemini planner — is **removed**, because Phase 1 already produced the shot
list. The worker consumes that shot list directly.

| Step | Model | Notes |
|------|-------|-------|
| Audio | **Kokoro TTS** | per-character voice + narrator; audio-first (its length sizes each shot) |
| Mute video | **Wan VACE** (diffusers) | headshots passed as **reference images** → the uploaded faces are generated in, not painted on |
| Face pass | **InsightFace + inswapper** | optional per-frame swap for tighter likeness |
| Merge | **ffmpeg** | audio-first sync (`apad` + `-shortest`), straight cuts |

Shot prompts are built from Phase 1's structured fields (background, each
character's clothing colour / pose / expression, camera framing, ambient sound).

## Setup

### 1. App environment variables (Vercel + `.env.local`)

```
ANIMATICS_WORKER_TOKEN=<long-random-string>   # shared secret for the Colab worker
# Email transport (pick ONE):
RESEND_API_KEY=<resend-key>                    # simplest
ANIMATICS_EMAIL_FROM=Animatics <you@yourdomain>
# — or —
SMTP_URL=smtp://user:pass@smtp.host:587        # requires `npm i nodemailer`
```

If no email transport is set, rendering still completes and the link is shown
in the app — only the email is skipped.

### 2. Colab notebook

Open `colab/animatics_render_worker.py` in Google Colab (or paste its cells).
- Runtime → GPU (T4 works with the 1.3B VACE model).
- Set `APP_BASE_URL` to your deployed app and `WORKER_TOKEN` to
  `ANIMATICS_WORKER_TOKEN`.
- Run all cells. The worker claims queued jobs, renders, uploads to your Drive,
  and reports back. Set `LOOP_FOREVER=True` to keep polling.

## Worker API (all require `x-animatics-worker-token`)

| Route | Purpose |
|-------|---------|
| `POST /api/animatics/render/claim` | claim next job → shotList + headshots |
| `POST /api/animatics/render/progress` | report free-text progress |
| `POST /api/animatics/render/complete` | report Drive link (or failure) → emails link |

User route: `POST /api/animatics/render` (queue an approved job).

## Honest limitations

- **Colab is a notebook you run, not an always-on server.** Free Colab
  disconnects after ~90 min idle and caps sessions at ~12 h. The realistic model
  is "approve, then run the notebook to render." For always-on, move the worker
  to Modal/RunPod (only the host changes — the code is the same).
- **Free video-model quality is a ceiling, not a bug.** Wan VACE 1.3B on a T4
  makes short clips with imperfect identity consistency. If quality isn't
  enough, swap the `VaceBackend.generate` body for a paid video API — the rest
  of the pipeline is unchanged.
- **A 10-episode story is a lot of GPU time** (many shots × clips × face-swap).
  Expect long runs on free Colab; Colab Pro or a bigger GPU helps a lot.
- **Gender for TTS voices** is currently inferred by a simple heuristic (Phase 1
  doesn't tag gender). To improve, have Phase 1 emit a gender per character and
  pass it through the claim payload.
