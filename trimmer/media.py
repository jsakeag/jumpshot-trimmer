"""What the timeline draws: a filmstrip of thumbnails and the audio's loudness, cached in
out/<video name>/.

The filmstrip is one JPEG grid of evenly spaced thumbnails, decoded from keyframes only so it
takes seconds even for a long video. The loudness is one byte per WAVE_STEP seconds (wave.bin).
"""

import json
import math
import subprocess

import numpy as np

from .export import probe
from .paths import project_dir
from .tennis import SAMPLE_RATE, load_audio

THUMB_H = 60
COLS = 20
MAX_THUMBS = 600
MIN_INTERVAL = 1.0  # seconds between thumbnails, at most this dense
WAVE_STEP = 0.02


def info_path(stem):
    return project_dir(stem) / "media.json"


def filmstrip_path(stem):
    return project_dir(stem) / "filmstrip.jpg"


def wave_path(stem):
    return project_dir(stem) / "wave.bin"


def load_info(stem):
    p = info_path(stem)
    return json.loads(p.read_text()) if p.exists() else None


def make(video, progress=None):
    """Build the filmstrip and loudness for a video. Returns the info the page needs to draw them."""
    stem = video.stem
    out_dir = project_dir(stem)
    out_dir.mkdir(parents=True, exist_ok=True)
    duration, has_audio, _ = probe(video)
    count = max(1, min(MAX_THUMBS, math.ceil(duration / MIN_INTERVAL)))
    rows = math.ceil(count / COLS)
    film = filmstrip_path(stem)
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-skip_frame", "nokey", "-i", str(video), "-an",
         "-vf", f"fps={count}/{duration},scale=-2:{THUMB_H},tile={COLS}x{rows}", "-frames:v", "1",
         "-q:v", "4", str(film)], capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(f"Couldn't make thumbnails: {proc.stderr.strip()[-300:]}")
    width = int(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", str(film)],
                               capture_output=True, text=True, check=True).stdout.strip())
    if progress:
        progress(0.3)

    samples = (load_audio(video, progress=progress and (lambda f: progress(0.3 + 0.7 * f))) if has_audio
               else np.zeros(0, np.float32))
    hop = int(SAMPLE_RATE * WAVE_STEP)
    n = len(samples) // hop
    peaks = np.abs(samples[:n * hop]).reshape(n, hop).max(1) if n else np.zeros(0)
    top = np.percentile(peaks, 99.5) if n else 1.0
    wave = np.clip(np.sqrt(peaks / max(top, 1e-6)), 0, 1)  # square root so quiet sounds still show
    wave_path(stem).write_bytes((wave * 255).astype(np.uint8).tobytes())

    info = {"duration": duration, "count": count, "interval": duration / count, "cols": COLS, "rows": rows,
            "thumb_w": width // COLS, "thumb_h": THUMB_H, "wave_step": WAVE_STEP}
    info_path(stem).write_text(json.dumps(info))
    return info
