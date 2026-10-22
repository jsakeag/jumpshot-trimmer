#!/usr/bin/env python3
"""Command-line side of the app (the editor is server.py).

Put videos in data/. Results go to out/<video name>/.

Usage:
    python cli.py detect IMG_1234.MOV points          # run a plugin; what it finds comes in as maybes
    python cli.py detect IMG_1234.MOV serves --far-box 0.47,0.42,1,0.79
    python cli.py list IMG_1234                       # annotations and their tags
    python cli.py review IMG_1234                     # every annotation, labeled, in one video
    python cli.py export IMG_1234                     # the confirmed annotations, clean
"""

import argparse
import shutil
import sys
import time
from pathlib import Path

from trimmer import paths, plugins, project
from trimmer.export import fmt_time


def progress_bar():
    started = time.time()

    def report(frac):
        el = time.time() - started
        left = f", ~{el / frac * (1 - frac):.0f}s left" if frac > 0.01 else ""
        print(f"\r  progress: {frac:.0%}{left} ", end="", flush=True)
    return report


def export_progress(frac):
    print(f"\r  exporting: {frac:.0%} ", end="\n" if frac >= 1 else "", flush=True)


def print_annotations(anns):
    print("  start    end      kind       status  tags")
    for a in anns:
        tags = ", ".join(f"{t['name']} {t['score']:g}" for t in a["tags"])
        print(f"  {fmt_time(a['start']):>7}  {fmt_time(a['end']):>7}  {project.KIND_LABEL[a['kind']]:<9}  "
              f"{'maybe' if a['maybe'] else '':<6}  {tags}")


def cmd_detect(args):
    video = paths.find_video(args.video)
    options = {}
    if args.far_box:
        options["far_box"] = [float(v) for v in args.far_box.split(",")]
    if args.tightness:
        options["tightness"] = args.tightness
    print(f"Running {plugins.get(args.plugin).label} on {video.name}...")
    data, added = project.run_plugin(video, args.plugin, options, progress=progress_bar())
    print(f"\nAdded {added} maybes.")
    print_annotations([a for a in data["annotations"] if a["source"] == args.plugin])


def cmd_list(args):
    data = project.load(Path(args.name).stem)
    print_annotations(data["annotations"])


def cmd_review(args):
    print(f"Exported {project.export_review(Path(args.name).stem, progress=export_progress)}")


def cmd_export(args):
    final, clips = project.export_final(Path(args.name).stem, progress=export_progress)
    print(f"Exported {final} ({len(clips)} clips, {fmt_time(clips[-1]['reel_end'])})")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("detect", help="run a plugin; what it finds comes in as maybes")
    d.add_argument("video", type=Path, help="video file, or just its name if it's in data/")
    d.add_argument("plugin", choices=list(plugins.PLUGINS),
                   help="; ".join(f"{p.name}: {p.about}" for p in plugins.PLUGINS.values()))
    d.add_argument("--far-box", metavar="X0,Y0,X1,Y1",
                   help="serves: box around the far baseline, as fractions of the frame, with room above "
                        "the server for the toss, e.g. 0.47,0.42,1,0.79")
    d.add_argument("--tightness", choices=list(plugins.PLUGINS["points"].choices["tightness"]),
                   help="points: loose keeps the most of each point, tight cuts the most (default: loose)")
    d.set_defaults(func=cmd_detect)

    for name, fn, about in (("list", cmd_list, "list a video's annotations"),
                            ("review", cmd_review, "export every annotation, maybes too, labeled"),
                            ("export", cmd_export, "export the confirmed annotations as one clean video")):
        c = sub.add_parser(name, help=about)
        c.add_argument("name", help="video name, e.g. IMG_0121")
        c.set_defaults(func=fn)

    args = p.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    try:
        args.func(args)
    except (FileNotFoundError, ValueError) as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
