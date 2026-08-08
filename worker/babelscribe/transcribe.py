#!/usr/bin/env python3
"""
Babelscribe — multi-lingual audio → English transcript + translation.

Given a Google Drive audio file (assumed to have "anyone with the link" read
access), this:

  1. Downloads the audio with gdown.
  2. Runs faster-whisper (CTranslate2 Whisper, free + high accuracy) TWICE:
       - task="transcribe": recognises speech in the ORIGINAL language(s) and
         reports the detected language per segment.
       - task="translate": Whisper's built-in any-language -> English.
  3. Aligns the two passes by timestamp and emits ONE English transcript.
     Segments whose original language was English print plain; segments in any
     other language (Hindi, Bengali, Hebrew, …) print their English translation
     wrapped in brackets tagged with the source language, e.g.

         Let's begin the meeting. [hi: Everyone please sit down.] Thank you.

Everything is written to OUT_DIR (default ./out) as:
  - transcript.txt   the bracketed English transcript (the deliverable)
  - transcript.json  structured segments (start, end, lang, english)

Env / args:
  DRIVE_FILE_ID   (required)  Google Drive file id
  RUN_ID          (optional)  correlation id, echoed into the outputs
  MODEL_SIZE      (optional)  faster-whisper model, default "large-v3"
  OUT_DIR         (optional)  output directory, default "out"

Usage:
  DRIVE_FILE_ID=abc123 python transcribe.py
  python transcribe.py <drive_file_id>
"""

import json
import os
import sys

import gdown
from faster_whisper import WhisperModel


def download_audio(file_id: str, dest: str) -> str:
    """Download a globally-readable Drive file by id. Returns the local path."""
    url = f"https://drive.google.com/uc?id={file_id}"
    out = gdown.download(url, dest, quiet=False, fuzzy=True)
    if not out or not os.path.exists(out):
        raise RuntimeError(
            "Download failed. Confirm the Drive file has 'anyone with the link' "
            "read access and that the id is correct."
        )
    return out


def _overlap(a_start, a_end, b_start, b_end) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def lang_for_span(orig_segments, start, end) -> str:
    """Pick the original-language label of the transcribe-pass segment that
    overlaps [start, end] the most. Falls back to '' when nothing overlaps."""
    best_lang, best_ov = "", 0.0
    for os_, oe, lang in orig_segments:
        ov = _overlap(start, end, os_, oe)
        if ov > best_ov:
            best_ov, best_lang = ov, lang
    return best_lang


def transcribe(file_id: str, model_size: str, out_dir: str, run_id: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    audio = download_audio(file_id, os.path.join(out_dir, "audio_input"))

    # GitHub-hosted runners are CPU-only; int8 keeps large-v3 tractable.
    device = os.getenv("WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("WHISPER_COMPUTE", "int8")
    print(f"[babelscribe] loading {model_size} on {device}/{compute_type} …", flush=True)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    # Pass 1 — original-language recognition, per-segment language.
    # multilingual=True lets Whisper switch languages within the file instead of
    # locking to the first detected one.
    print("[babelscribe] pass 1/2 — detecting languages …", flush=True)
    seg_iter, _info = model.transcribe(
        audio, task="transcribe", multilingual=True, vad_filter=True
    )
    orig = [(s.start, s.end, (s.language or "").lower()) for s in seg_iter]

    # Pass 2 — everything translated to English.
    print("[babelscribe] pass 2/2 — translating to English …", flush=True)
    seg_iter_en, _info_en = model.transcribe(
        audio, task="translate", vad_filter=True
    )
    english = [(s.start, s.end, s.text.strip()) for s in seg_iter_en]

    # Align + format.
    segments_out = []
    pieces = []
    for start, end, text_en in english:
        if not text_en:
            continue
        lang = lang_for_span(orig, start, end)
        is_english = lang in ("", "en")
        pieces.append(text_en if is_english else f"[{lang}: {text_en}]")
        segments_out.append(
            {
                "start": round(start, 2),
                "end": round(end, 2),
                "lang": lang or "en",
                "english": text_en,
                "bracketed": not is_english,
            }
        )

    transcript = " ".join(pieces).strip()

    with open(os.path.join(out_dir, "transcript.txt"), "w", encoding="utf-8") as f:
        f.write(transcript + "\n")

    with open(os.path.join(out_dir, "transcript.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "run_id": run_id,
                "drive_file_id": file_id,
                "model": model_size,
                "segments": segments_out,
                "transcript": transcript,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"[babelscribe] done — {len(segments_out)} segments", flush=True)
    print("[babelscribe] --- transcript ---", flush=True)
    print(transcript, flush=True)


def main() -> int:
    file_id = os.getenv("DRIVE_FILE_ID") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not file_id:
        print("error: DRIVE_FILE_ID (env) or a file id argument is required", file=sys.stderr)
        return 2
    model_size = os.getenv("MODEL_SIZE", "large-v3")
    out_dir = os.getenv("OUT_DIR", "out")
    run_id = os.getenv("RUN_ID", "local")
    try:
        transcribe(file_id, model_size, out_dir, run_id)
    except Exception as e:  # surface a clean message to the Actions log
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
