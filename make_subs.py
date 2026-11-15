#!/usr/bin/env python3
"""
make_subs.py - transcribe an mp4's audio into timed, censored subtitles.

Setup (once):   pip install faster-whisper
Use:            python make_subs.py video.mp4 001     (finds it in source/)
Writes:         clips/clip_001.subs.json        (what the website loads)
                clips/clip_001.transcript.txt   (readable, timestamped)

Expletives are replaced with "--" here, at build time, so the uncensored
words never reach the browser. Add your own with --extra words.txt
(one word per line; start a line with * to match inside longer words).
"""
import argparse, json, os, re, subprocess, sys

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")   # silence a harmless Windows warning

# Matched anywhere inside a word (so "fucking", "motherfucker", "bullshit" all hit).
SUBSTRING = ["fuck", "shit", "cunt", "bitch", "bastard", "motherf", "asshole",
             "dumbass", "jackass", "wank"]
# Matched as a whole word, with optional s/es/ed/ing/in/in' ending.
# (Kept whole-word so "class" and "assume" are left alone.)
WHOLE = ["ass", "arse", "damn", "dammit", "goddamn", "dick", "cock", "crap",
         "crappy", "piss", "slut", "whore", "hoe", "prick", "twat"]

TOKEN = re.compile(r"^([^\w'*]*)(.*?)([^\w'*]*)$")


def load_rules(extra_path=None):
    sub, whole = list(SUBSTRING), list(WHOLE)
    if extra_path:
        with open(extra_path, encoding="utf-8") as f:
            for line in f:
                w = line.strip().lower()
                if not w or w.startswith("#"):
                    continue
                (sub if w.startswith("*") else whole).append(w.lstrip("*"))
    alt = "|".join(re.escape(w) for w in sorted(whole, key=len, reverse=True))
    whole_re = re.compile(r"^(?:%s)(?:s|es|ed|ing|in|in')?$" % alt)
    return sub, whole_re


def censor_word(word, rules):
    sub, whole_re = rules
    m = TOKEN.match(word.strip())
    lead, core, trail = m.groups()
    low = core.lower()
    if not core:
        return word.strip()
    if "*" in core or any(s in low for s in sub) or whole_re.match(low.strip("'")):
        return lead + "--" + trail
    return word.strip()


def build_cues(words, max_chars=70, max_dur=5.0, gap=0.7):
    """Group (text,start,end) words into short subtitle cues."""
    cues, cur = [], None
    for w in words:
        text = w["text"]
        if not text:
            continue
        if cur:
            too_long = len(cur["t"]) + 1 + len(text) > max_chars
            pause = w["start"] - cur["e"] > gap
            too_slow = w["end"] - cur["s"] > max_dur
            sentence = cur["t"][-1] in ".?!" and len(cur["t"]) > 25
            if too_long or pause or too_slow or sentence:
                cues.append(cur)
                cur = None
        if cur is None:
            cur = {"s": w["start"], "e": w["end"], "t": text}
        else:
            cur["t"] += " " + text
            cur["e"] = w["end"]
    if cur:
        cues.append(cur)
    for i, c in enumerate(cues):            # hold briefly, min length, never overlap
        nxt = cues[i + 1]["s"] if i + 1 < len(cues) else float("inf")
        c["e"] = min(max(c["e"] + 0.2, c["s"] + 0.8), nxt)
        c["s"], c["e"] = round(c["s"], 2), round(c["e"], 2)
    return cues


def load_audio(path):
    """Decode the mp4's audio with ffmpeg -> 16 kHz mono float samples.
    (Done here so we don't depend on faster-whisper's own decoder, which
    breaks with some versions of the 'av' package.)"""
    import numpy as np
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path,
           "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    try:
        raw = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    except FileNotFoundError:
        sys.exit("ffmpeg not found on PATH (winget install Gyan.FFmpeg, then reopen VS Code).")
    except subprocess.CalledProcessError:
        sys.exit("ffmpeg could not read the audio from %s" % path)
    return np.frombuffer(raw, dtype=np.float32)


_MODELS = {}


def transcribe(path, model_size, lang):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install faster-whisper")
    audio = load_audio(path)
    if audio.size == 0:
        print("No audio track found; writing empty subtitles.")
        return []
    if model_size not in _MODELS:
        _MODELS[model_size] = WhisperModel(model_size, device="cpu", compute_type="int8")
    model = _MODELS[model_size]
    segments, _ = model.transcribe(audio, language=lang, word_timestamps=True,
                                   vad_filter=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"text": w.word, "start": w.start, "end": w.end})
    return words


def stamp(t):
    return "%02d:%04.1f" % (int(t // 60), t % 60)


def make_subs_for(video, clip_id, out_dir="clips", model="small", lang=None,
                  extra=None, max_chars=70):
    """Transcribe one video and write clip_<id>.subs.json / .transcript.txt."""
    rules = load_rules(extra)
    words = transcribe(video, model, lang)
    for w in words:
        w["text"] = censor_word(w["text"], rules)
    cues = build_cues(words, max_chars=max_chars)
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(out_dir, "clip_%s" % clip_id)
    with open(base + ".subs.json", "w", encoding="utf-8") as f:
        json.dump({"id": clip_id, "cues": cues}, f, ensure_ascii=False, indent=1)
    with open(base + ".transcript.txt", "w", encoding="utf-8") as f:
        for c in cues:
            f.write("[%s] %s\n" % (stamp(c["s"]), c["t"]))
    return base, len(cues)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("id", help="clip ID, e.g. 001 (same one used for ascii_conv)")
    ap.add_argument("--src-dir", default="source", help="where the mp4s live")
    ap.add_argument("--out-dir", default="clips")
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--lang", default=None, help="e.g. en (default: auto-detect)")
    ap.add_argument("--extra", default=None, help="file with extra words to censor")
    ap.add_argument("--max-chars", type=int, default=70)
    a = ap.parse_args()

    video = a.video if os.path.exists(a.video) else os.path.join(a.src_dir, a.video)
    if not os.path.exists(video):
        sys.exit("Can't find %s (also looked in %s/)" % (a.video, a.src_dir))
    base, n = make_subs_for(video, a.id, a.out_dir, a.model, a.lang, a.extra, a.max_chars)
    print("clip %s: %d cues -> %s.subs.json" % (a.id, n, base))


if __name__ == "__main__":
    main()
