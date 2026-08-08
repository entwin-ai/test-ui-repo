#!/usr/bin/env python3
"""
Babelscribe — multi-lingual audio → English transcript + translation.

Given a Google Drive audio file (assumed to have "anyone with the link" read
access), this:

  1. Downloads the audio with gdown.
  2. Runs faster-whisper (free, high-accuracy CTranslate2 Whisper) TWICE:
       - task="transcribe": recognises speech in the ORIGINAL language(s).
       - task="translate": Whisper's built-in any-language -> English.
  3. Aligns the two passes by timestamp and emits ONE English transcript.
     A segment's original language is identified from the Unicode script of its
     transcribe-pass text (Devanagari -> Hindi, Bengali, Hebrew, …). Segments
     whose original language was English print plain; other-language segments
     print their English translation wrapped in a language-tagged bracket, e.g.

         Let's begin the meeting. [hi: Everyone please sit down.] Thank you.

  4. Renders the transcript to a PDF (transcript.pdf).
  5. If a recipient + Resend API key are configured, emails the PDF to the
     logged-in user as an attachment.

Outputs (in OUT_DIR, default ./out):
  - transcript.txt    the bracketed English transcript (the deliverable)
  - transcript.pdf    same content as a PDF (emailed + uploaded as artifact)
  - transcript.json   structured segments

Env / args:
  DRIVE_FILE_ID   (required)  Google Drive file id
  RUN_ID          (optional)  correlation id, echoed into the outputs
  MODEL_SIZE      (optional)  faster-whisper model, default "large-v3"
  OUT_DIR         (optional)  output directory, default "out"
  USER_EMAIL      (optional)  recipient for the result PDF
  RESEND_API_KEY  (optional)  enables the email step
  BABELSCRIBE_EMAIL_FROM (optional) From address, default onboarding@resend.dev
"""

import base64
import json
import os
import sys
import urllib.request

import gdown
from faster_whisper import WhisperModel


# ----- language identification by Unicode script -------------------------------
# The target languages use distinct scripts, so script detection is exact and
# needs no extra ML model. Latin text is treated as English (the transcribe pass
# already romanises nothing — English stays English, and any residual Latin is
# left unbracketed).
def _script_lang(text: str) -> str:
    counts = {"hi": 0, "bn": 0, "he": 0, "en": 0}
    for ch in text:
        o = ord(ch)
        if 0x0900 <= o <= 0x097F:            # Devanagari
            counts["hi"] += 1
        elif 0x0980 <= o <= 0x09FF:          # Bengali
            counts["bn"] += 1
        elif 0x0590 <= o <= 0x05FF:          # Hebrew
            counts["he"] += 1
        elif (0x41 <= o <= 0x5A) or (0x61 <= o <= 0x7A):  # Latin
            counts["en"] += 1
    # Pick the non-English script with the most characters; if none, English.
    non_en = {k: v for k, v in counts.items() if k != "en" and v > 0}
    if non_en:
        return max(non_en, key=non_en.get)
    return "en"


def download_audio(file_id: str, dest: str) -> str:
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
    """Original-language label of the transcribe-pass segment overlapping
    [start, end] the most. '' if nothing overlaps."""
    best_lang, best_ov = "", 0.0
    for os_, oe, lang in orig_segments:
        ov = _overlap(start, end, os_, oe)
        if ov > best_ov:
            best_ov, best_lang = ov, lang
    return best_lang


def render_pdf(transcript: str, out_path: str, run_id: str) -> None:
    """Render the transcript to a simple, readable PDF. Uses a Unicode TTF if
    available so any stray non-Latin characters still render; falls back to core
    fonts (the transcript body is English, so this is safe)."""
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()

    unicode_font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    have_unicode = os.path.exists(unicode_font)
    if have_unicode:
        pdf.add_font("DejaVu", "", unicode_font)
        pdf.add_font("DejaVu", "B", unicode_font)
        body_font = "DejaVu"
    else:
        body_font = "Helvetica"

    pdf.set_font(body_font, "B", 16)
    pdf.cell(0, 10, "Babelscribe transcript", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(body_font, "", 9)
    pdf.set_text_color(120, 120, 120)
    pdf.cell(0, 6, f"Run: {run_id}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_text_color(20, 20, 20)
    pdf.set_font(body_font, "", 12)
    # multi_cell wraps the whole transcript. Encode-safe for core fonts.
    text = transcript if have_unicode else transcript.encode("latin-1", "replace").decode("latin-1")
    pdf.multi_cell(0, 7, text)
    pdf.output(out_path)


def send_email_with_pdf(to: str, pdf_path: str, run_id: str) -> None:
    """Email the PDF as an attachment via the Resend HTTP API (same provider the
    app already uses for Animatics). No-ops with a log line if unconfigured."""
    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        print("[babelscribe] RESEND_API_KEY not set — skipping email.", flush=True)
        return
    if not to:
        print("[babelscribe] no recipient (USER_EMAIL) — skipping email.", flush=True)
        return

    from_addr = os.getenv("BABELSCRIBE_EMAIL_FROM", "Babelscribe <onboarding@resend.dev>")
    with open(pdf_path, "rb") as f:
        content_b64 = base64.b64encode(f.read()).decode("ascii")

    payload = {
        "from": from_addr,
        "to": [to],
        "subject": "Your Babelscribe transcript is ready",
        "text": (
            "Your multi-lingual audio has been transcribed and translated to "
            "English (non-English parts kept in brackets).\n\n"
            "The transcript is attached as a PDF.\n\n— Babelscribe"
        ),
        "html": (
            "<p>Your multi-lingual audio has been transcribed and translated to "
            "English (non-English parts kept in brackets).</p>"
            "<p>The transcript is attached as a PDF.</p>"
            "<p style='color:#667'>— Babelscribe</p>"
        ),
        "attachments": [{"filename": "babelscribe-transcript.pdf", "content": content_b64}],
    }

    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
            print(f"[babelscribe] email sent to {to}: {body[:200]}", flush=True)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        print(f"[babelscribe] email failed ({e.code}): {detail}", flush=True)
    except Exception as e:
        print(f"[babelscribe] email error: {e}", flush=True)


def transcribe(file_id: str, model_size: str, out_dir: str, run_id: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    audio = download_audio(file_id, os.path.join(out_dir, "audio_input"))

    device = os.getenv("WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("WHISPER_COMPUTE", "int8")
    print(f"[babelscribe] loading {model_size} on {device}/{compute_type} …", flush=True)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    # Pass 1 — original-language recognition. Whisper auto-detects and can switch
    # language across the file; we identify each segment's language from the
    # script of its text (exact for Devanagari/Bengali/Hebrew vs Latin).
    print("[babelscribe] pass 1/2 — transcribing (original languages) …", flush=True)
    seg_iter, _info = model.transcribe(audio, task="transcribe", vad_filter=True)
    orig = [(s.start, s.end, _script_lang(s.text)) for s in seg_iter]

    # Pass 2 — everything translated to English.
    print("[babelscribe] pass 2/2 — translating to English …", flush=True)
    seg_iter_en, _info_en = model.transcribe(audio, task="translate", vad_filter=True)
    english = [(s.start, s.end, s.text.strip()) for s in seg_iter_en]

    segments_out, pieces = [], []
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

    transcript = " ".join(pieces).strip() or "(no speech detected)"

    txt_path = os.path.join(out_dir, "transcript.txt")
    pdf_path = os.path.join(out_dir, "transcript.pdf")
    json_path = os.path.join(out_dir, "transcript.json")

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(transcript + "\n")
    with open(json_path, "w", encoding="utf-8") as f:
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

    print("[babelscribe] rendering PDF …", flush=True)
    render_pdf(transcript, pdf_path, run_id)

    print("[babelscribe] emailing result …", flush=True)
    send_email_with_pdf(os.getenv("USER_EMAIL", ""), pdf_path, run_id)

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
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
