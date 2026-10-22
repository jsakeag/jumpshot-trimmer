"""Tennis point detection from sound: ball strikes are sharp "pock" sounds, and a point is a
run of them close together.

Sounds that aren't racket hits are filtered out first: anything that lasts too long (wind,
rustling) or is much quieter than this video's typical hit (dribbling a ball while walking).

Tightness trades how much is kept against how much of each point survives. Measured on one
48-minute session (point time covered on a fully labeled 5 minutes / final length):
loose 92% / 24.5 min, medium 86% / 21.9 min, tight 80% / 19.4 min.
"""

import subprocess
from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

SAMPLE_RATE = 16000
HOP = 160  # 10 ms analysis frames


# minimum loudness, as a fraction of this video's median hit loudness
TIGHTNESS = {"loose": 0.4, "medium": 0.5, "tight": 0.6}


@dataclass
class TennisParams:
    tightness: str = "loose"
    threshold: float = 5.0   # how far a sound must jump above the background to count as a hit
    max_sound_ms: float = 80  # racket hits are short; longer sounds are wind or rustling
    gap: float = 8.0         # hits closer than this (seconds) belong to the same point
    min_hits: int = 3        # fewer hits than this isn't a point
    pad: float = 1.5         # seconds kept before the first and after the last hit
    maybe_hits: int = 5      # points with fewer hits than this are marked maybe


def load_audio(video, progress=None):
    """Mono 16 kHz samples. progress(fraction) as the audio is decoded."""
    from .export import probe
    duration = probe(video)[0]
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
                             "-f", "f32le", "pipe:1"], stdout=subprocess.PIPE)
    chunks, read = [], 0
    while chunk := proc.stdout.read(SAMPLE_RATE * 4 * 10):  # 10 s at a time
        chunks.append(chunk)
        read += len(chunk)
        if progress:
            progress(min(1.0, read / 4 / SAMPLE_RATE / duration))
    if proc.wait():
        raise RuntimeError(f"Couldn't read the audio from {video}")
    return np.frombuffer(b"".join(chunks), dtype=np.float32)


def hit_times(samples, threshold):
    """Times (s) of sharp sounds that jump well above the last half second's background."""
    d = np.diff(samples, prepend=0)  # emphasizes sharp attacks over rumble and voices
    n = len(d) // HOP
    if n < 100:
        return np.array([])
    energy = np.sqrt((d[:n * HOP].reshape(n, HOP) ** 2).mean(1))
    background = np.median(sliding_window_view(np.pad(energy, (51, 0), mode="edge"), 51)[:-1], axis=1)
    ratio = energy / (background + 1e-6)
    local_max = sliding_window_view(np.pad(ratio, 15, mode="constant"), 31).max(1)  # within ±150 ms
    peaks = np.flatnonzero((ratio > threshold) & (ratio >= local_max))
    return peaks * HOP / SAMPLE_RATE


def sound_shape(samples, times):
    """(duration in ms above half its peak, peak loudness) of the sound at each time."""
    env = np.sqrt(np.maximum(np.convolve(samples ** 2, np.ones(80) / 80, "same"), 0))  # 5 ms envelope
    out = []
    for t in times:
        i = int(t * SAMPLE_RATE)
        e = env[max(0, i - SAMPLE_RATE // 10):i + SAMPLE_RATE * 3 // 10]  # -100 .. +300 ms
        peak = e.max() if len(e) else 0.0
        out.append(((e > peak / 2).sum() / SAMPLE_RATE * 1000, peak))
    return np.array(out).reshape(-1, 2)


def racket_hits(samples, params):
    """Sharp sounds, minus the ones that last too long or are too quiet to be a racket hit."""
    times = hit_times(samples, params.threshold)
    if not len(times):
        return times
    dur_ms, peak = sound_shape(samples, times).T
    short = dur_ms <= params.max_sound_ms
    if not short.any():
        return times[:0]
    min_loud = TIGHTNESS[params.tightness] * np.median(peak[short])
    return times[short & (peak >= min_loud)]


def detect_points(video, params=None, progress=None):
    """Clips ({start, end, maybe}) for each point, in seconds."""
    params = params or TennisParams()
    if params.tightness not in TIGHTNESS:
        raise ValueError(f"Unknown tightness {params.tightness!r} (choose from {', '.join(TIGHTNESS)})")
    samples = load_audio(video, progress)
    duration = len(samples) / SAMPLE_RATE
    hits = racket_hits(samples, params)
    groups = []
    for h in hits:
        if groups and h - groups[-1][-1] <= params.gap:
            groups[-1].append(h)
        else:
            groups.append([h])
    clips = []
    for g in groups:
        if len(g) < params.min_hits:
            continue
        start, end = max(0.0, g[0] - params.pad), min(duration, g[-1] + params.pad)
        maybe = len(g) < params.maybe_hits
        if clips and start <= clips[-1]["end"]:
            clips[-1]["end"] = end
            clips[-1]["maybe"] = clips[-1]["maybe"] and maybe
        else:
            clips.append({"start": start, "end": end, "maybe": maybe})
    return [{**c, "start": round(c["start"], 3), "end": round(c["end"], 3)} for c in clips]
