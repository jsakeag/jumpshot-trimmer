#!/usr/bin/env python3
"""Find jumpshots in a basketball video and export them as one combined video.

Each clip runs from 0.5 s before the gather (lowest hip point) to 0.5 s after
release (highest wrist point while airborne).

Put videos in data/. Results go to out/<video name>/.

Usage:
    python jumpshot_trimmer.py IMG_1234.MOV
    python jumpshot_trimmer.py IMG_1234.MOV -o highlights.mp4 --dry-run
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

import cv2
import numpy as np

# COCO keypoint indices
L_SH, R_SH, L_WR, R_WR, L_HIP, R_HIP = 5, 6, 9, 10, 11, 12

KP_CONF = 0.3          # ignore keypoints below this confidence
MAX_GAP_S = 0.3        # interpolate missing pose data over gaps up to this long
LOST_TRACK_S = 1.0     # forget the tracked player after this long without a detection
MAYBE_SCALE = 0.5      # near misses must reach this fraction of each shot threshold

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"   # input videos; bare filenames are looked up here
OUT_DIR = ROOT / "out"     # results go to out/<video name>/


# ---------------------------------------------------------------- pose pass

def pick_person(boxes, confs, prev_center):
    """Stick with the player nearest the last one we tracked, else the most confident."""
    centers = (boxes[:, :2] + boxes[:, 2:]) / 2
    if prev_center is not None:
        i = int(np.argmin(np.linalg.norm(centers - prev_center, axis=1)))
    else:
        i = int(np.argmax(confs))
    return i, centers[i]


def extract_pose(video, model_name, device, analysis_fps, batch):
    from ultralytics import YOLO

    model = YOLO(model_name)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        sys.exit(f"Could not open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    stride = max(1, round(fps / analysis_fps))

    times, kps = [], []
    prev_center, last_seen = None, -1e9
    frames, frame_times = [], []
    idx, started = 0, time.time()

    def flush():
        nonlocal prev_center, last_seen
        results = model.predict(frames, device=device, verbose=False)
        for t, r in zip(frame_times, results):
            k = np.full((17, 3), np.nan)
            if r.keypoints is not None and len(r.boxes):
                if t - last_seen > LOST_TRACK_S:
                    prev_center = None
                i, prev_center = pick_person(
                    r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy(), prev_center)
                k = r.keypoints.data[i].cpu().numpy()
                last_seen = t
            times.append(t)
            kps.append(k)
        frames.clear()
        frame_times.clear()

    while True:
        if idx % stride:
            if not cap.grab():
                break
        else:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
            frame_times.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000)
            if len(frames) == batch:
                flush()
        idx += 1
        if idx % 300 == 0 and total:
            el = time.time() - started
            print(f"\r  pose: {idx}/{total} frames ({idx / total:.0%}), "
                  f"~{el / idx * (total - idx):.0f}s left ", end="", flush=True)
    if frames:
        flush()
    cap.release()
    print()
    if not times:
        sys.exit("No frames could be read from the video")
    return np.array(times), np.array(kps), fps / stride


# ---------------------------------------------------------------- signals

def fill_gaps(a, max_gap):
    """Linearly interpolate NaN runs no longer than max_gap samples."""
    a = a.copy()
    ok = ~np.isnan(a)
    if ok.sum() < 2:
        return a
    idx = np.arange(len(a))
    filled = np.interp(idx, idx[ok], a[ok])
    i = 0
    while i < len(a):
        if ok[i]:
            i += 1
            continue
        j = i
        while j < len(a) and not ok[j]:
            j += 1
        if 0 < i and j < len(a) and j - i <= max_gap:
            a[i:j] = filled[i:j]
        i = j
    return a


def smooth(a, n):
    if n <= 1:
        return a
    padded = np.pad(a, (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(padded, np.ones(n) / n, mode="valid")


def rolling_nanmedian(a, n):
    half = n // 2
    out = np.full_like(a, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for i in range(len(a)):
            out[i] = np.nanmedian(a[max(0, i - half):i + half + 1])
    return out


def compute_signals(kps, fps):
    """Per-frame signals in image coords (y grows downward)."""
    xy = kps[..., :2].copy()
    xy[kps[..., 2] < KP_CONF] = np.nan
    y = xy[..., 1]
    gap = int(MAX_GAP_S * fps)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        sh_xy = np.nanmean(xy[:, [L_SH, R_SH]], axis=1)
        hip_xy = np.nanmean(xy[:, [L_HIP, R_HIP]], axis=1)
        wrist_y = np.nanmin(y[:, [L_WR, R_WR]], axis=1)  # higher of the two wrists
    torso = rolling_nanmedian(np.linalg.norm(sh_xy - hip_xy, axis=1), int(fps))
    k = max(1, int(fps / 15))
    sig = {
        "shoulder_y": sh_xy[:, 1],
        "hip_y": hip_xy[:, 1],
        "wrist_y": wrist_y,
        "torso": torso,
    }
    sig = {name: smooth(fill_gaps(v, gap), k) for name, v in sig.items()}
    # how far the higher wrist is above the shoulders, in torso lengths
    sig["arm"] = (sig["shoulder_y"] - sig["wrist_y"]) / sig["torso"]
    return sig


# ---------------------------------------------------------------- detection

def runs(mask):
    """(start, end) index pairs of contiguous True runs, end exclusive."""
    d = np.diff(np.concatenate([[0], mask.astype(int), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def detect_shots(times, sig, fps, args):
    """Return (shots, near_misses). Near misses pass looser thresholds but not the real ones."""
    arm, hip, torso = sig["arm"], sig["hip_y"], sig["torso"]
    n = len(times)
    s = lambda sec: int(round(sec * fps))
    shots, near = [], []
    for a, b in runs(np.nan_to_num(arm) > args.arm_up * MAYBE_SCALE):
        release = a + int(np.nanargmax(arm[a:b]))
        base = hip[max(0, release - s(2.0)):max(1, release - s(0.6))]
        air = hip[max(0, release - s(0.5)):min(n, release + s(0.3))]
        lo = max(0, release - s(1.2))
        dip = hip[lo:max(lo + 1, release - s(0.1))]
        if any(np.all(np.isnan(x)) for x in (base, air, dip)) or np.isnan(torso[release]):
            continue
        rise = (np.nanmedian(base) - np.nanmin(air)) / torso[release]
        gather = lo + int(np.nanargmax(dip))
        cand = {
            "gather": round(float(times[gather]), 3),
            "release": round(float(times[release]), 3),
            "arm": round(float(arm[release]), 2),
            "jump": round(float(rise), 2),
        }
        arms_up_long_enough = np.sum(arm[a:b] > args.arm_up) >= s(0.1)
        if arms_up_long_enough and cand["arm"] >= args.arm_peak and rise >= args.jump:
            if not shots or cand["release"] - shots[-1]["release"] >= 1.0:
                shots.append(cand)
        elif cand["arm"] >= args.arm_peak * MAYBE_SCALE and rise >= args.jump * MAYBE_SCALE:
            near.append(cand)
    near = [c for c in near if all(abs(c["release"] - sh["release"]) >= 1.0 for sh in shots)]
    return shots, near


def clip_windows(shots, duration, pre, post):
    """Pad each shot and merge any windows that overlap."""
    out = []
    for sh in shots:
        start, end = max(0.0, sh["gather"] - pre), min(duration, sh["release"] + post)
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(round(a, 3), round(b, 3)) for a, b in out]


# ---------------------------------------------------------------- export

def probe(video):
    info = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", str(video)], capture_output=True, text=True, check=True).stdout)
    has_audio = any(st["codec_type"] == "audio" for st in info["streams"])
    return float(info["format"]["duration"]), has_audio


def export(video, windows, out, has_audio):
    expr = "+".join(f"between(t,{a},{b})" for a, b in windows)
    filters = f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB,format=yuv420p[v]"
    maps = ["-map", "[v]"]
    if has_audio:
        filters += f";[0:a]aselect='{expr}',asetpts=N/SR/TB[a]"
        maps += ["-map", "[a]"]
    cmd = ["ffmpeg", "-y", "-v", "error", "-stats", "-i", str(video),
           "-filter_complex", filters, *maps,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)


def export_separate(video, windows, out_dir):
    """One small file per window, named by its start time in the source video."""
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("maybe_*.mp4"):
        old.unlink()
    for a, b in windows:
        m, sec = divmod(int(a), 60)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(a), "-to", str(b), "-i", str(video),
                        "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                        "-c:a", "aac", str(out_dir / f"maybe_{m:02d}m{sec:02d}s.mp4")], check=True)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video", type=Path)
    p.add_argument("-o", "--output", type=Path, help="default: out/<video>/<video>_jumpshots.mp4")
    p.add_argument("--pre", type=float, default=0.5, help="seconds before gather (default 0.5)")
    p.add_argument("--post", type=float, default=0.5, help="seconds after release (default 0.5)")
    p.add_argument("--model", default="yolo11s-pose.pt", help="ultralytics pose model")
    p.add_argument("--device", default=None, help="mps, cpu, cuda (default: mps if available)")
    p.add_argument("--analysis-fps", type=float, default=30, help="frames/sec to run pose on")
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--arm-up", type=float, default=0.5,
                   help="wrist height above shoulders (torso lengths) counted as arms up")
    p.add_argument("--arm-peak", type=float, default=0.8,
                   help="min wrist height above shoulders at release (torso lengths)")
    p.add_argument("--jump", type=float, default=0.15,
                   help="min hip rise during the shot (torso lengths)")
    p.add_argument("--dry-run", action="store_true", help="detect and write JSON, skip export")
    p.add_argument("--no-maybe", action="store_true", help="skip exporting near-miss clips")
    p.add_argument("--debug", action="store_true", help="also write per-frame signals CSV")
    args = p.parse_args()

    if not args.video.exists() and (DATA_DIR / args.video).exists():
        args.video = DATA_DIR / args.video
    if not args.video.exists():
        sys.exit(f"No such file: {args.video}")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    if args.device is None:
        import torch
        args.device = "mps" if torch.backends.mps.is_available() else "cpu"
    out = args.output or OUT_DIR / args.video.stem / f"{args.video.stem}_jumpshots.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)

    duration, has_audio = probe(args.video)
    print(f"Analyzing {args.video.name} ({duration:.0f}s) on {args.device}...")
    times, kps, fps = extract_pose(args.video, args.model, args.device, args.analysis_fps, args.batch)
    sig = compute_signals(kps, fps)
    shots, near = detect_shots(times, sig, fps, args)
    windows = clip_windows(shots, duration, args.pre, args.post)
    near_windows = clip_windows(near, duration, args.pre, args.post)

    json_path = out.with_suffix(".json")
    json_path.write_text(json.dumps({"video": str(args.video), "shots": shots, "clips": windows,
                                     "near_misses": near}, indent=2))
    if args.debug:
        cols = ["shoulder_y", "hip_y", "wrist_y", "torso", "arm"]
        data = np.column_stack([times] + [sig[c] for c in cols])
        np.savetxt(out.with_suffix(".signals.csv"), data, delimiter=",", fmt="%.4f",
                   header="t," + ",".join(cols), comments="")

    print(f"Found {len(shots)} jumpshots -> {len(windows)} clips "
          f"({sum(b - a for a, b in windows):.1f}s), plus {len(near)} near misses. "
          f"Times saved to {json_path}")
    if args.dry_run:
        return
    if windows:
        export(args.video, windows, out, has_audio)
        print(f"Exported {out}")
    if near_windows and not args.no_maybe:
        maybe_dir = out.with_name("maybe")
        export_separate(args.video, near_windows, maybe_dir)
        print(f"Near misses in {maybe_dir}/ (named by time in the original video)")


if __name__ == "__main__":
    main()
