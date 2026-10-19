#!/usr/bin/env python3
"""Command-line version of the jumpshot trimmer (the web app is server.py).

Put videos in data/. Results go to out/<video name>/.

Usage:
    python cli.py detect IMG_1234.MOV    # pass 1: numbered review video
    python cli.py trim IMG_1234 3,7      # pass 2: final video without clips 3 and 7
"""

import argparse
import shutil
import sys
import time
from pathlib import Path

from trimmer import paths, project
from trimmer.detect import DetectParams
from trimmer.export import fmt_time, timeline


def print_clips(clips):
    print("  clip  in video  in original")
    for c in clips:
        print(f"  {c['n']:>4}  {fmt_time(c['reel_start']):>8}  {fmt_time(c['start']):>11}"
              f"{'  maybe' if c['maybe'] else ''}")


def pose_progress():
    started = time.time()

    def report(done, total):
        el = time.time() - started
        print(f"\r  pose: {done}/{total} frames ({done / total:.0%}), "
              f"~{el / done * (total - done):.0f}s left ", end="", flush=True)
    return report


def parse_clip_numbers(s):
    """'3,7,10-12' -> {3, 7, 10, 11, 12}"""
    nums = set()
    for part in filter(None, (p.strip() for p in s.split(","))):
        lo, _, hi = part.partition("-")
        nums.update(range(int(lo), int(hi or lo) + 1))
    return nums


def cmd_detect(args):
    video = paths.find_video(args.video)
    params = DetectParams(pre=args.pre, post=args.post, arm_up=args.arm_up, arm_peak=args.arm_peak,
                          jump=args.jump, model=args.model, device=args.device,
                          analysis_fps=args.analysis_fps, batch=args.batch)
    print(f"Analyzing {video.name}...")
    data, cached = project.detect(video, params, fresh=args.fresh, debug=args.debug, progress=pose_progress())
    print("  used cached pose" if cached else "")
    clips = timeline(data["clips"])
    maybes = sum(c["maybe"] for c in clips)
    print(f"Found {len(clips)} clips ({maybes} maybe).")
    print_clips(clips)
    if args.dry_run or not clips:
        return
    review = project.export_review(video.stem)
    print(f"\nExported {review}\nWatch it, then drop clips with:\n"
          f"  python cli.py trim {video.stem} <clip numbers, e.g. 3,7,10-12>")


def cmd_trim(args):
    stem = Path(args.name).stem
    data = project.set_dropped(stem, args.drop)
    kept = project.kept_clips(data)
    print(f"Dropping {len(data['dropped'])} of {len(data['clips'])} clips -> {len(kept)} clips "
          f"({kept[-1]['reel_end']:.1f}s)." if kept else "")
    final, _ = project.export_final(stem)
    print(f"Exported {final}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    defaults = DetectParams()

    d = sub.add_parser("detect", help="pass 1: find shots and export a numbered review video")
    d.add_argument("video", type=Path, help="video file, or just its name if it's in data/")
    d.add_argument("--pre", type=float, default=defaults.pre, help="seconds before gather")
    d.add_argument("--post", type=float, default=defaults.post, help="seconds after release")
    d.add_argument("--arm-up", type=float, default=defaults.arm_up,
                   help="wrist height above shoulders (torso lengths) counted as arms up")
    d.add_argument("--arm-peak", type=float, default=defaults.arm_peak,
                   help="min wrist height above shoulders at release (torso lengths)")
    d.add_argument("--jump", type=float, default=defaults.jump, help="min hip rise during the shot (torso lengths)")
    d.add_argument("--model", default=defaults.model, help="ultralytics pose model")
    d.add_argument("--device", default=None, help="mps, cpu, cuda (default: mps if available)")
    d.add_argument("--analysis-fps", type=float, default=defaults.analysis_fps, help="frames/sec to run pose on")
    d.add_argument("--batch", type=int, default=defaults.batch)
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
    try:
        args.func(args)
    except (FileNotFoundError, ValueError) as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
