"""Detectors that annotate a video for you. Each finds windows of one kind; they come in as maybes
for you to confirm. None of them export anything.

A plugin's run(video, out_dir, options, progress) returns [{start, end, weak}], where weak marks a
borderline find, and progress(fraction) reports progress. Slow passes cache in out_dir.
"""

from dataclasses import dataclass, field
from typing import Callable

from .detect import DetectParams, clip_windows, compute_signals, detect_shots
from .export import probe
from .pose import default_device, load_or_extract_pose
from . import serves, tennis


@dataclass
class Plugin:
    name: str
    label: str
    kind: str
    about: str
    run: Callable
    needs_box: bool = False  # options["far_box"]: (x0, y0, x1, y1) frame fractions around the far baseline
    choices: dict = field(default_factory=dict)  # option -> allowed values, first is the default

    def check(self, options):
        """The options this plugin takes, validated and with defaults filled in. Raises ValueError."""
        out = {}
        if self.needs_box:
            box = options.get("far_box")
            try:
                box = [min(1.0, max(0.0, float(v))) for v in box]
            except (TypeError, ValueError):
                box = []
            if len(box) != 4 or box[2] - box[0] < 0.05 or box[3] - box[1] < 0.05:
                raise ValueError("Draw the far-baseline box first (x0, y0, x1, y1 frame fractions, not tiny)")
            out["far_box"] = box
        for k, allowed in self.choices.items():
            v = options.get(k, allowed[0])
            if v not in allowed:
                raise ValueError(f"{k} should be one of {', '.join(allowed)}")
            out[k] = v
        return out

    def info(self):
        return {"name": self.name, "label": self.label, "kind": self.kind, "about": self.about,
                "needs_box": self.needs_box, "choices": self.choices}


def _weak(found):
    return [{"start": f["start"], "end": f["end"], "weak": f["maybe"]} for f in found]


def run_serves(video, out_dir, options, progress):
    return _weak(serves.detect_serves(video, options["far_box"], out_dir / "serve_pose.npz", progress=progress))


def run_points(video, out_dir, options, progress):
    return _weak(tennis.detect_points(video, tennis.TennisParams(tightness=options["tightness"]), progress=progress))


def run_shots(video, out_dir, options, progress):
    params = DetectParams()
    times, kps, fps, _ = load_or_extract_pose(
        video, out_dir / "pose.npz", params.model, params.device or default_device(), params.analysis_fps,
        params.batch, progress=progress and (lambda done, total: progress(done / total)))
    shots, near = detect_shots(times, compute_signals(kps, fps), fps, params)
    cands = [{**c, "maybe": False} for c in shots] + [{**c, "maybe": True} for c in near]
    return _weak(clip_windows(cands, probe(video)[0], params.pre, params.post))


PLUGINS = {p.name: p for p in (
    Plugin("serves", "Tennis serves", "serve",
           "Finds serves from either player by pose: arms up after standing still. Slow (about 0.8x the "
           "video's length the first time; cached after). Needs a box around the far baseline.",
           run_serves, needs_box=True),
    Plugin("points", "Tennis points", "point",
           "Finds points from the sound of the ball. Takes seconds. Tighter cuts more but may trim real points.",
           run_points, choices={"tightness": list(tennis.TIGHTNESS)}),
    Plugin("shots", "Basketball shots", "shot",
           "Finds jumpshots and layups by pose, from the gather to just after release. A few minutes.",
           run_shots),
)}


def get(name):
    if name not in PLUGINS:
        raise ValueError(f"Unknown plugin {name!r} (choose from {', '.join(PLUGINS)})")
    return PLUGINS[name]
