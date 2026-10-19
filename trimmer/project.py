"""A video's project: detection results, dropped clips and exports, stored in out/<video name>/.

This is the API the CLI and the web app share.
"""

import json
import threading
from pathlib import Path

import numpy as np

from .detect import DetectParams, clip_windows, compute_signals, detect_shots
from .export import export, probe, timeline
from .paths import project_dir
from .pose import default_device, load_or_extract_pose

_lock = threading.RLock()  # clips.json is read-modify-written from web requests and jobs


def clips_path(stem):
    return project_dir(stem) / "clips.json"


def review_path(stem):
    return project_dir(stem) / f"{stem}_review.mp4"


def final_path(stem):
    return project_dir(stem) / f"{stem}_final.mp4"


def load(stem):
    p = clips_path(stem)
    if not p.exists():
        raise FileNotFoundError(f"No results for {stem}. Run detection first.")
    data = json.loads(p.read_text())
    data.setdefault("dropped", [])
    data.setdefault("final", None)
    return data


def save(stem, data):
    p = clips_path(stem)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def detect(video, params=None, fresh=False, debug=False, progress=None):
    """Find shots and save the numbered clip list. Resets any dropped clips.

    progress(frames_done, frames_total) reports the pose pass.
    Returns (project data, whether cached pose was used).
    """
    params = params or DetectParams()
    stem = video.stem
    out_dir = project_dir(stem)
    out_dir.mkdir(parents=True, exist_ok=True)
    duration = probe(video)[0]
    times, kps, fps, cached = load_or_extract_pose(
        video, out_dir / "pose.npz", params.model, params.device or default_device(),
        params.analysis_fps, params.batch, fresh, progress)
    sig = compute_signals(kps, fps)
    shots, near = detect_shots(times, sig, fps, params)
    cands = [{**c, "maybe": False} for c in shots] + [{**c, "maybe": True} for c in near]
    clips = [{"n": n, **w} for n, w in enumerate(clip_windows(cands, duration, params.pre, params.post), 1)]
    data = {"video": str(video), "clips": clips, "dropped": [], "final": None,
            "shots": shots, "near_misses": near}
    with _lock:
        save(stem, data)
    if debug:
        cols = ["shoulder_y", "hip_y", "wrist_y", "torso", "arm"]
        np.savetxt(out_dir / "signals.csv", np.column_stack([times] + [sig[c] for c in cols]),
                   delimiter=",", fmt="%.4f", header="t," + ",".join(cols), comments="")
    return data, cached


def set_dropped(stem, dropped):
    with _lock:
        data = load(stem)
        n = len(data["clips"])
        bad = sorted(x for x in dropped if not 1 <= x <= n)
        if bad:
            raise ValueError(f"No clip {bad} (clips are 1-{n})")
        data["dropped"] = sorted(set(dropped))
        save(stem, data)
        return data


def kept_clips(data):
    """Clips that survive the drops, placed on the final video's timeline."""
    dropped = set(data["dropped"])
    return timeline([c for c in data["clips"] if c["n"] not in dropped])


def export_review(stem, progress=None):
    """Every clip, numbered with subtitles and chapters."""
    data = load(stem)
    out = review_path(stem)
    export(Path(data["video"]), timeline(data["clips"]), out, labels=True, progress=progress)
    return out


def export_final(stem, progress=None):
    """The kept clips, clean (no labels), ready to share. Returns (path, kept clips)."""
    data = load(stem)
    clips = kept_clips(data)
    if not clips:
        raise ValueError("Every clip is dropped.")
    out = final_path(stem)
    export(Path(data["video"]), clips, out, labels=False, progress=progress)
    with _lock:
        latest = load(stem)
        latest["final"] = {"dropped": data["dropped"], "clips": len(clips), "duration": clips[-1]["reel_end"]}
        save(stem, latest)
    return out, clips
