#!/usr/bin/env python3
"""
Animatics Phase 2 — Colab render worker
=======================================
Adapted from story_to_movie_faces.py. The key change: the PLANNING step is gone
— Phase 1 (the Next.js app) already produced the shot list. This worker CLAIMS a
job from the app, renders it with the same open-source ML stack, uploads the MP4
to Google Drive, and reports the link back so the app can email it.

ML models reused from the original program (all free / open-weight):
  * Kokoro TTS          — narration + per-character voices (audio-first)
  * Wan VACE (diffusers)— mute video, with headshots as REFERENCE IMAGES so the
                          uploaded faces are injected at generation time
  * InsightFace + inswapper — optional per-frame face-swap for tighter likeness
  * ffmpeg              — audio-first merge (apad + -shortest), straight cuts

Only the paid Gemini planner from the original is dropped — Phase 1 does that job.

HOW TO RUN (in Google Colab, GPU runtime):
  1. Runtime → Change runtime type → GPU (T4 is fine with the 1.3B VACE model).
  2. Fill in APP_BASE_URL and WORKER_TOKEN below (token = ANIMATICS_WORKER_TOKEN
     from your Vercel env).
  3. Run all cells. The worker loops: claim → render → upload → report, until the
     queue is empty (or forever if LOOP_FOREVER=True).

This file is a plain-python mirror of the notebook so it can live in the repo and
be version-controlled; paste its cells into Colab, or run `%load` it.
"""

# ===========================================================================
# CELL 1 — install dependencies (run once per Colab session)
# ===========================================================================
# !pip -q install google-genai==0.* diffusers transformers accelerate torch \
#     soundfile numpy kokoro insightface onnxruntime-gpu opencv-python requests
# !apt -qq install -y ffmpeg
# NOTE: leave the Gemini package out if you like — this worker does not plan.

# ===========================================================================
# CELL 2 — configuration
# ===========================================================================
import os

# The base URL of your deployed app, e.g. "https://your-app.vercel.app"
APP_BASE_URL = os.environ.get("ANIMATICS_APP_URL", "https://YOUR-APP.vercel.app")
# Must equal ANIMATICS_WORKER_TOKEN in your app's environment.
WORKER_TOKEN = os.environ.get("ANIMATICS_WORKER_TOKEN", "PASTE_WORKER_TOKEN_HERE")

WORKER_ID = os.environ.get("ANIMATICS_WORKER_ID", "colab-1")
LOOP_FOREVER = False          # True = keep polling; False = drain queue then stop
POLL_SECONDS = 15

# Model + render settings (mirror the original program)
SMALL_VACE = "Wan-AI/Wan2.1-VACE-1.3B-diffusers"   # Colab T4 friendly (fp16)
BIG_VACE = "Wan-AI/Wan2.1-VACE-14B-diffusers"       # needs A100 / big GPU
VACE_MODEL = os.environ.get("ANIMATICS_VACE", SMALL_VACE)

VIDEO_FPS = 16
WIDTH, HEIGHT = 832, 480
CLIP_SECONDS = 5
MIN_SHOT_SECONDS = 4
MAX_REF_IMAGES = 3
AUDIO_SR = 24000
LINE_GAP_S = 0.35
MAX_SHOTS = int(os.environ.get("ANIMATICS_MAX_SHOTS", "40"))

FACE_SWAP = os.environ.get("ANIMATICS_FACE_SWAP", "1") == "1"
INSWAPPER_PATH = os.environ.get("ANIMATICS_INSWAPPER", "inswapper_128.onnx")

NARRATOR_VOICE = "bm_george"
FEMALE_VOICES = ["af_heart", "af_bella", "bf_emma", "af_nicole"]
MALE_VOICES = ["am_michael", "am_adam", "bm_lewis", "am_eric"]
NEGATIVE_PROMPT = ("blurry, low quality, distorted faces, extra limbs, text, "
                   "watermark, subtitles, flickering")

DRIVE_FOLDER_NAME = "Animatics Renders"   # where MP4s land in your Drive

# ===========================================================================
# CELL 3 — data model + app API client
# ===========================================================================
import base64
import json
import math
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import requests
import soundfile as sf


def _hdr():
    return {"x-animatics-worker-token": WORKER_TOKEN,
            "Content-Type": "application/json"}


def claim_job():
    """Ask the app for the next queued render job. Returns the job dict or None."""
    r = requests.post(f"{APP_BASE_URL}/api/animatics/render/claim",
                      headers=_hdr(), data=json.dumps({"workerId": WORKER_ID}),
                      timeout=60)
    r.raise_for_status()
    return r.json().get("job")


def report_progress(job_id, text):
    try:
        requests.post(f"{APP_BASE_URL}/api/animatics/render/progress",
                      headers=_hdr(),
                      data=json.dumps({"jobId": job_id, "progress": text}),
                      timeout=30)
    except Exception as e:
        print("  (progress report failed:", e, ")")


def report_complete(job_id, drive_link=None, drive_file_id=None, failure=None):
    requests.post(f"{APP_BASE_URL}/api/animatics/render/complete",
                  headers=_hdr(),
                  data=json.dumps({"jobId": job_id, "driveLink": drive_link,
                                   "driveFileId": drive_file_id,
                                   "failure": failure}),
                  timeout=60)


@dataclass
class Line:
    speaker: str
    text: str


@dataclass
class Shot:
    visual: str
    camera: str
    present: list = field(default_factory=list)
    lines: list = field(default_factory=list)
    ambient: str = ""
    audio_path: Path = None
    audio_dur: float = 0.0
    video_path: Path = None


def shotlist_to_shots(job):
    """
    Adapt Phase 1's shot list (from the app) into the render Shot objects.

    Phase 1 shot shape:
      { scene, shot, background, cameraFraming, ambientSound,
        characters: [{name, clothingColor, pose, expression}],
        dialogue:   [{speaker, line}] }
    """
    shots = []
    for s in (job.get("shotList") or [])[:MAX_SHOTS]:
        chars = s.get("characters", []) or []
        present = [c.get("name", "").strip() for c in chars if c.get("name")]

        # Build a rich visual prompt from Phase 1's structured fields.
        char_desc = "; ".join(
            f"{c.get('name','')} wearing {c.get('clothingColor','')}, "
            f"{c.get('pose','')}, {c.get('expression','')} expression"
            for c in chars
        )
        visual = (f"{s.get('background','')}. {char_desc}." if char_desc
                  else s.get("background", ""))

        lines = []
        for d in s.get("dialogue", []) or []:
            spk = (d.get("speaker") or "").strip()
            txt = (d.get("line") or "").strip()
            if txt:
                lines.append(Line(spk or "NARRATOR", txt))

        shots.append(Shot(visual=visual,
                          camera=s.get("cameraFraming", ""),
                          present=present, lines=lines,
                          ambient=s.get("ambientSound", "")))
    return shots


def infer_gender(name, role, existing):
    """
    Phase 1 doesn't tag gender. Simple heuristic for VOICE PICK ONLY: alternate
    male/female deterministically so each character gets a stable, distinct
    voice. (You can improve this by having Phase 1 emit gender later.)
    """
    if name in existing:
        return existing[name]
    # Deterministic alternation by hash so the same name always maps the same way.
    return "female" if (hash(name) % 2 == 0) else "male"


# ===========================================================================
# CELL 4 — headshots: decode the data URLs the app sent into local files
# ===========================================================================
def save_headshots(job, workdir: Path):
    """Returns {name: Path} for characters that have a headshot."""
    out = {}
    for c in job.get("characters", []):
        data_url = c.get("headshot")
        name = c.get("name", "").strip()
        if not data_url or not name:
            continue
        # data:<mime>;base64,<...>
        try:
            header, b64 = data_url.split(",", 1)
            ext = "png" if "png" in header else ("webp" if "webp" in header else "jpg")
            p = workdir / f"head_{len(out)}.{ext}"
            p.write_bytes(base64.b64decode(b64))
            out[name] = p
        except Exception as e:
            print(f"  could not decode headshot for {name}: {e}")
    return out


# ===========================================================================
# CELL 5 — audio (Kokoro TTS), audio-first (mirrors original build_audio)
# ===========================================================================
class VoiceCast:
    def __init__(self, characters: dict):
        self.map = {"NARRATOR": NARRATOR_VOICE}
        f = m = 0
        for name, gender in characters.items():
            if gender == "female":
                self.map[name] = FEMALE_VOICES[f % len(FEMALE_VOICES)]; f += 1
            else:
                self.map[name] = MALE_VOICES[m % len(MALE_VOICES)]; m += 1

    def voice(self, speaker):
        return self.map.get(speaker, NARRATOR_VOICE)


def build_audio(shots, characters, workdir: Path):
    from kokoro import KPipeline
    print("[2/5] Kokoro TTS (narration & dialogue)...")
    tts = KPipeline(lang_code="a")
    cast = VoiceCast(characters)
    gap = np.zeros(int(LINE_GAP_S * AUDIO_SR), dtype=np.float32)

    for k, shot in enumerate(shots, start=1):
        chunks = []
        for line in shot.lines:
            for _, _, audio in tts(line.text, voice=cast.voice(line.speaker)):
                chunks.append(np.asarray(audio, dtype=np.float32))
            chunks.append(gap)
        wav = (np.concatenate(chunks) if chunks
               else np.zeros(int(0.5 * AUDIO_SR), dtype=np.float32))
        shot.audio_path = workdir / f"shot_{k:03d}.wav"
        sf.write(shot.audio_path, wav, AUDIO_SR)
        shot.audio_dur = len(wav) / AUDIO_SR


# ===========================================================================
# CELL 6 — mute video (Wan VACE + reference images) (mirrors original)
# ===========================================================================
class VaceBackend:
    def __init__(self, model_id: str, char_images: dict):
        import torch
        from PIL import Image
        from diffusers import WanVACEPipeline
        print(f"      loading VACE: {model_id} (first run downloads weights)")
        self.pipe = WanVACEPipeline.from_pretrained(model_id, torch_dtype=torch.bfloat16)
        self.pipe.enable_model_cpu_offload()
        self.refs = {}
        for name, p in char_images.items():
            img = Image.open(p).convert("RGB")
            img.thumbnail((512, 512))
            self.refs[name] = img

    def _num_frames(self, seconds):
        return (int(seconds * VIDEO_FPS) // 4) * 4 + 1

    def generate(self, prompt, seconds, present):
        ref_images = [self.refs[n] for n in present[:MAX_REF_IMAGES]
                      if n in self.refs] or None
        out = self.pipe(prompt=prompt, negative_prompt=NEGATIVE_PROMPT,
                        reference_images=ref_images,
                        height=HEIGHT, width=WIDTH,
                        num_frames=self._num_frames(seconds),
                        guidance_scale=5.0)
        return out.frames[0]


def build_video(shots, backend, world_bible, workdir: Path, job_id):
    from diffusers.utils import export_to_video
    print("[3/5] Wan VACE mute video with character references...")
    for k, shot in enumerate(shots, start=1):
        report_progress(job_id, f"video {k}/{len(shots)}")
        target = max(shot.audio_dur + 0.5, MIN_SHOT_SECONDS)
        n_clips = math.ceil(target / CLIP_SECONDS)
        prompt = (f"{world_bible}\nShot: {shot.visual}\nCamera: {shot.camera}\n"
                  f"Cinematic, coherent motion, no text.")
        clip_paths = []
        for c in range(n_clips):
            frames = backend.generate(prompt, CLIP_SECONDS, shot.present)
            p = workdir / f"shot_{k:03d}_clip_{c}.mp4"
            export_to_video(frames, str(p), fps=VIDEO_FPS)
            clip_paths.append(p)
        shot.video_path = _concat(clip_paths, workdir / f"shot_{k:03d}_video.mp4", workdir)


# ===========================================================================
# CELL 7 — optional face-swap (InsightFace + inswapper) (mirrors original)
# ===========================================================================
class FaceSwapper:
    def __init__(self, char_images: dict, inswapper_path: Path):
        import cv2
        from insightface.app import FaceAnalysis
        from insightface.model_zoo import get_model
        self.cv2 = cv2
        self.app = FaceAnalysis(name="buffalo_l")
        self.app.prepare(ctx_id=0, det_size=(640, 640))
        self.swapper = get_model(str(inswapper_path))
        self.sources = {}
        for name, p in char_images.items():
            img = cv2.imread(str(p))
            faces = self.app.get(img)
            if faces:
                self.sources[name] = max(faces, key=lambda f: f.det_score)
            else:
                print(f"      warning: no face found in headshot for {name}")

    def swap_video(self, path: Path, present: list):
        cv2 = self.cv2
        cands = {n: self.sources[n] for n in present if n in self.sources}
        if not cands:
            return
        cap = cv2.VideoCapture(str(path))
        fps = cap.get(cv2.CAP_PROP_FPS) or VIDEO_FPS
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        tmp = path.with_suffix(".swap.mp4")
        out = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            for face in self.app.get(frame):
                if len(cands) == 1:
                    src = next(iter(cands.values()))
                else:
                    src = max(cands.values(), key=lambda s: float(
                        np.dot(face.normed_embedding, s.normed_embedding)))
                frame = self.swapper.get(frame, face, src, paste_back=True)
            out.write(frame)
        cap.release(); out.release()
        tmp.replace(path)


def face_pass(shots, swapper, job_id):
    print("[4/5] InsightFace swap pass...")
    for k, shot in enumerate(shots, start=1):
        if shot.present:
            report_progress(job_id, f"face-swap {k}/{len(shots)}")
            swapper.swap_video(shot.video_path, shot.present)


# ===========================================================================
# CELL 8 — merge (ffmpeg, audio-first) (mirrors original)
# ===========================================================================
def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def _concat(paths, out: Path, workdir: Path) -> Path:
    lst = workdir / (out.stem + "_list.txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
    _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
          "-c", "copy", str(out)])
    return out


def merge(shots, output: Path, workdir: Path):
    print("[5/5] Merging video + audio...")
    shot_files = []
    for k, shot in enumerate(shots, start=1):
        out = workdir / f"final_shot_{k:03d}.mp4"
        _run(["ffmpeg", "-y", "-i", str(shot.video_path), "-i", str(shot.audio_path),
              "-af", "apad", "-map", "0:v", "-map", "1:a",
              "-c:v", "libx264", "-preset", "medium", "-crf", "18",
              "-pix_fmt", "yuv420p", "-r", str(VIDEO_FPS),
              "-c:a", "aac", "-ar", "48000", "-ac", "2",
              "-shortest", str(out)])
        shot_files.append(out)
    _concat(shot_files, output, workdir)


# ===========================================================================
# CELL 9 — Google Drive upload (Colab-native: mount + copy, then share)
# ===========================================================================
def upload_to_drive(mp4_path: Path, title: str):
    """
    Upload the MP4 to the user's Google Drive and return (link, file_id).

    Colab makes this trivial: google.colab.drive.mount puts Drive at
    /content/drive. We copy the file into a folder there, then use PyDrive2 (or
    the Drive API) to fetch a shareable link. If the API path isn't set up, we
    still copy the file and return the Drive UI folder — you can right-click →
    share. For a fully automatic shareable link, the API branch below runs.
    """
    from google.colab import drive as colab_drive
    colab_drive.mount("/content/drive", force_remount=False)

    folder = Path("/content/drive/MyDrive") / DRIVE_FOLDER_NAME
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / mp4_path.name
    import shutil as _sh
    _sh.copy(str(mp4_path), str(dest))

    # Try to produce a shareable link via the Drive API (auth is already granted
    # to Colab). This makes the emailed link work without manual sharing.
    try:
        from googleapiclient.discovery import build
        from google.colab import auth as colab_auth
        colab_auth.authenticate_user()
        service = build("drive", "v3")

        # Find the just-copied file by name in the folder.
        q = (f"name = '{mp4_path.name}' and trashed = false")
        res = service.files().list(q=q, spaces="drive",
                                   fields="files(id, name)").execute()
        files = res.get("files", [])
        if not files:
            return (f"https://drive.google.com/drive/my-drive", None)
        file_id = files[0]["id"]
        # Make it link-shareable (anyone with the link can view).
        service.permissions().create(
            fileId=file_id, body={"role": "reader", "type": "anyone"}).execute()
        link = f"https://drive.google.com/file/d/{file_id}/view"
        return (link, file_id)
    except Exception as e:
        print("  Drive API share failed, returning folder link:", e)
        return ("https://drive.google.com/drive/my-drive", None)


# ===========================================================================
# CELL 10 — render one job end to end
# ===========================================================================
def render_job(job, backend_cache):
    job_id = job["id"]
    title = job.get("title", "Untitled")
    print(f"\n=== Rendering job {job_id}: {title} ===")
    workdir = Path(tempfile.mkdtemp(prefix="animatics_"))
    try:
        # 1) headshots
        char_images = save_headshots(job, workdir)

        # 2) characters + gender (voice pick)
        characters = {}
        for c in job.get("characters", []):
            nm = c.get("name", "").strip()
            if nm:
                characters[nm] = infer_gender(nm, c.get("role", ""), characters)

        # 3) shots from Phase 1's shot list
        shots = shotlist_to_shots(job)
        if not shots:
            report_complete(job_id, failure="No shots in shot list.")
            return
        world_bible = job.get("screenplayProse", "")[:1500]  # style hint only

        report_progress(job_id, "audio")
        build_audio(shots, characters, workdir)

        # Reuse a loaded VACE backend across jobs (loading weights is slow).
        if "backend" not in backend_cache:
            backend_cache["backend"] = VaceBackend(VACE_MODEL, char_images)
        else:
            # refresh reference images for this job's characters
            from PIL import Image
            refs = {}
            for name, p in char_images.items():
                img = Image.open(p).convert("RGB"); img.thumbnail((512, 512))
                refs[name] = img
            backend_cache["backend"].refs = refs
        backend = backend_cache["backend"]

        build_video(shots, backend, world_bible, workdir, job_id)

        if FACE_SWAP and char_images and Path(INSWAPPER_PATH).exists():
            face_pass(shots, FaceSwapper(char_images, Path(INSWAPPER_PATH)), job_id)
        elif FACE_SWAP:
            print("  (face-swap requested but inswapper model not found; skipping)")

        report_progress(job_id, "merging")
        output = workdir / "movie.mp4"
        merge(shots, output, workdir)

        report_progress(job_id, "uploading")
        link, file_id = upload_to_drive(output, title)

        report_complete(job_id, drive_link=link, drive_file_id=file_id)
        print(f"=== Done: {link} ===")
    except Exception as e:
        import traceback; traceback.print_exc()
        report_complete(job_id, failure=str(e)[:500])
    finally:
        import shutil as _sh
        _sh.rmtree(workdir, ignore_errors=True)


# ===========================================================================
# CELL 11 — main loop: claim → render → repeat
# ===========================================================================
def worker_loop():
    backend_cache = {}
    while True:
        try:
            job = claim_job()
        except Exception as e:
            print("claim failed:", e); time.sleep(POLL_SECONDS); continue

        if not job:
            if LOOP_FOREVER:
                print("queue empty; waiting..."); time.sleep(POLL_SECONDS); continue
            print("queue empty; stopping."); break

        render_job(job, backend_cache)


if __name__ == "__main__":
    print("Animatics Colab render worker")
    print("App:", APP_BASE_URL, "| worker:", WORKER_ID,
          "| VACE:", VACE_MODEL, "| face-swap:", FACE_SWAP)
    worker_loop()
