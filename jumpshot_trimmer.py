#!/usr/bin/env python3
"""Find jumpshots in a basketball video and export them as one combined video.

Each clip runs from 0.5 s before the gather (lowest hip point) to 0.5 s after
release (highest wrist point while airborne).

Put videos in data/. Results go to out/<video name>/.

Usage:
    python jumpshot_trimmer.py detect IMG_1234.MOV    # pass 1: numbered review video
    python jumpshot_trimmer.py trim IMG_1234 3,7      # pass 2: final video without clips 3 and 7
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


def load_or_extract_pose(args, cache):
    """Pose is the slow step, so save it and reuse it when re-running with new thresholds."""
    key = f"{args.video.resolve()}|{args.video.stat().st_size}|{args.model}|{args.analysis_fps}"
    if cache.exists() and not args.fresh:
        c = np.load(cache)
        if str(c["key"]) == key:
            print(f"  using cached pose from {cache}")
            return c["times"], c["kps"], float(c["fps"])
    times, kps, fps = extract_pose(args.video, args.model, args.device, args.analysis_fps, args.batch)
    np.savez_compressed(cache, times=times, kps=kps, fps=fps, key=key)
    return times, kps, fps


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


def clip_windows(cands, duration, pre, post):
    """Pad each candidate and merge any windows that overlap. A merged clip is a maybe
    only if everything in it is."""
    out = []
    for c in sorted(cands, key=lambda c: c["gather"]):
        start, end = max(0.0, c["gather"] - pre), min(duration, c["release"] + post)
        if out and start <= out[-1]["end"]:
            out[-1]["end"] = max(out[-1]["end"], end)
            out[-1]["maybe"] = out[-1]["maybe"] and c["maybe"]
        else:
            out.append({"start": start, "end": end, "maybe": c["maybe"]})
    return [{**w, "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in out]


# ---------------------------------------------------------------- export

def probe(video):
    info = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", str(video)], capture_output=True, text=True, check=True).stdout)
    has_audio = any(st["codec_type"] == "audio" for st in info["streams"])
    return float(info["format"]["duration"]), has_audio


def fmt_time(sec, ms=False):
    m, s = divmod(sec, 60)
    if ms:
        h, m = divmod(int(m), 60)
        return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")
    return f"{int(m)}:{int(s):02d}"


def timeline(clips):
    """Where each clip lands in the combined video."""
    out, reel = [], 0.0
    for c in clips:
        d = c["end"] - c["start"]
        out.append({**c, "reel_start": round(reel, 3), "reel_end": round(reel + d, 3)})
        reel += d
    return out


def label(c):
    return f"Clip {c['n']}{' (maybe)' if c['maybe'] else ''} · {fmt_time(c['start'])} in original"


def write_clip_labels(clips, srt_path, chapters_path):
    """Subtitle + chapter files that label each clip in the combined video."""
    srt, chap = [], [";FFMETADATA1"]
    for i, c in enumerate(clips, 1):
        srt += [str(i), f"{fmt_time(c['reel_start'], True)} --> {fmt_time(c['reel_end'], True)}", label(c), ""]
        chap += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(c['reel_start'] * 1000)}",
                 f"END={int(c['reel_end'] * 1000)}", f"title={label(c)}"]
    srt_path.write_text("\n".join(srt))
    chapters_path.write_text("\n".join(chap) + "\n")


def export(video, clips, out, labels):
    """Join the clips into one video, keeping the original's metadata. With labels, clip numbers
    are added as subtitles and chapters."""
    _, has_audio = probe(video)
    expr = "+".join(f"between(t,{c['start']},{c['end']})" for c in clips)
    filters = f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB,format=yuv420p[v]"
    maps = ["-map", "[v]"]
    if has_audio:
        filters += f";[0:a]aselect='{expr}',asetpts=N/SR/TB[a]"
        maps += ["-map", "[a]"]
    inputs, label_opts = ["-i", str(video)], []
    if labels:
        srt, chapters = out.with_suffix(".srt"), out.with_suffix(".chapters.txt")
        write_clip_labels(clips, srt, chapters)
        inputs += ["-i", str(chapters), "-i", str(srt)]
        maps += ["-map", "2:s", "-map_chapters", "1"]
        label_opts = ["-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-disposition:s:0", "default"]
    cmd = ["ffmpeg", "-y", "-v", "error", "-stats", *inputs, "-filter_complex", filters, *maps,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
           *label_opts, "-map_metadata", "0",  # capture date + location, so Photos sorts it right
           "-movflags", "+faststart+use_metadata_tags", str(out)]
    subprocess.run(cmd, check=True)


def print_clips(clips):
    print("  clip  in video  in original")
    for c in clips:
        print(f"  {c['n']:>4}  {fmt_time(c['reel_start']):>8}  {fmt_time(c['start']):>11}"
              f"{'  maybe' if c['maybe'] else ''}")


# ---------------------------------------------------------------- commands

def find_video(path):
    if not path.exists() and (DATA_DIR / path).exists():
        path = DATA_DIR / path
    if not path.exists():
        sys.exit(f"No such file: {path} (put videos in {DATA_DIR})")
    return path.resolve()


def parse_clip_numbers(s):
    """'3,7,10-12' -> {3, 7, 10, 11, 12}"""
    nums = set()
    for part in filter(None, (p.strip() for p in s.split(","))):
        lo, _, hi = part.partition("-")
        nums.update(range(int(lo), int(hi or lo) + 1))
    return nums


def cmd_detect(args):
    video = find_video(args.video)
    if args.device is None:
        import torch
        args.device = "mps" if torch.backends.mps.is_available() else "cpu"
    out_dir = OUT_DIR / video.stem
    out_dir.mkdir(parents=True, exist_ok=True)

    duration, _ = probe(video)
    print(f"Analyzing {video.name} ({duration:.0f}s) on {args.device}...")
    args.video = video
    times, kps, fps = load_or_extract_pose(args, out_dir / "pose.npz")
    sig = compute_signals(kps, fps)
    shots, near = detect_shots(times, sig, fps, args)
    cands = [{**c, "maybe": False} for c in shots] + [{**c, "maybe": True} for c in near]
    clips = [{"n": n, **w} for n, w in enumerate(clip_windows(cands, duration, args.pre, args.post), 1)]

    (out_dir / "clips.json").write_text(json.dumps(
        {"video": str(video), "clips": clips, "shots": shots, "near_misses": near}, indent=2))
    if args.debug:
        cols = ["shoulder_y", "hip_y", "wrist_y", "torso", "arm"]
        np.savetxt(out_dir / "signals.csv", np.column_stack([times] + [sig[c] for c in cols]),
                   delimiter=",", fmt="%.4f", header="t," + ",".join(cols), comments="")

    clips = timeline(clips)
    print(f"Found {len(shots)} shots + {len(near)} maybes -> {len(clips)} clips.")
    print_clips(clips)
    if args.dry_run or not clips:
        return
    review = out_dir / f"{video.stem}_review.mp4"
    export(video, clips, review, labels=True)
    print(f"\nExported {review}\nWatch it, then drop clips with:\n"
          f"  python jumpshot_trimmer.py trim {video.stem} <clip numbers, e.g. 3,7,10-12>")


def cmd_trim(args):
    stem = Path(args.name).stem
    clips_path = OUT_DIR / stem / "clips.json"
    if not clips_path.exists():
        sys.exit(f"No {clips_path}. Run detect first.")
    data = json.loads(clips_path.read_text())
    clips = data["clips"]
    bad = sorted(n for n in args.drop if not 1 <= n <= len(clips))
    if bad:
        sys.exit(f"No clip {bad} (clips are 1-{len(clips)})")
    kept = timeline([c for c in clips if c["n"] not in args.drop])
    if not kept:
        sys.exit("That drops every clip.")
    print(f"Dropping {len(args.drop)} of {len(clips)} clips -> {len(kept)} clips "
          f"({kept[-1]['reel_end']:.1f}s).")
    final = OUT_DIR / stem / f"{stem}_final.mp4"
    export(Path(data["video"]), kept, final, labels=False)
    print(f"Exported {final}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("detect", help="pass 1: find shots and export a numbered review video")
    d.add_argument("video", type=Path, help="video file, or just its name if it's in data/")
    d.add_argument("--pre", type=float, default=0.5, help="seconds before gather (default 0.5)")
    d.add_argument("--post", type=float, default=0.5, help="seconds after release (default 0.5)")
    d.add_argument("--arm-up", type=float, default=0.4,
                   help="wrist height above shoulders (torso lengths) counted as arms up")
    d.add_argument("--arm-peak", type=float, default=0.55,
                   help="min wrist height above shoulders at release (torso lengths)")
    d.add_argument("--jump", type=float, default=0.1, help="min hip rise during the shot (torso lengths)")
    d.add_argument("--model", default="yolo11s-pose.pt", help="ultralytics pose model")
    d.add_argument("--device", default=None, help="mps, cpu, cuda (default: mps if available)")
    d.add_argument("--analysis-fps", type=float, default=30, help="frames/sec to run pose on")
    d.add_argument("--batch", type=int, default=16)
    d.add_argument("--fresh", action="store_true", help="ignore cached pose and re-run it")
    d.add_argument("--dry-run", action="store_true", help="list clips, skip the video export")
    d.add_argument("--debug", action="store_true", help="also write per-frame signals CSV")
    d.set_defaults(func=cmd_detect)

    t = sub.add_parser("trim", help="pass 2: export a final video without the clips you drop")
    t.add_argument("name", help="video name, e.g. IMG_0121")
    t.add_argument("drop", type=parse_clip_numbers, metavar="CLIPS",
                   help="clip numbers from the review video to drop, e.g. 3,7,10-12")
    t.set_defaults(func=cmd_trim)

    args = p.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    args.func(args)


if __name__ == "__main__":
    main()
