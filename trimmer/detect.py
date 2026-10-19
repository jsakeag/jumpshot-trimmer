"""Shot detection: turn per-frame keypoints into shot and near-miss clips.

Each clip runs from `pre` seconds before the gather (lowest hip point) to `post`
seconds after release (highest wrist point while airborne).
"""

import warnings
from dataclasses import dataclass

import numpy as np

# COCO keypoint indices
L_SH, R_SH, L_WR, R_WR, L_HIP, R_HIP = 5, 6, 9, 10, 11, 12

KP_CONF = 0.3          # ignore keypoints below this confidence
MAX_GAP_S = 0.3        # interpolate missing pose data over gaps up to this long
MAYBE_SCALE = 0.5      # near misses must reach this fraction of each shot threshold


@dataclass
class DetectParams:
    pre: float = 0.5           # seconds before gather
    post: float = 0.5          # seconds after release
    arm_up: float = 0.4        # wrist height above shoulders (torso lengths) counted as arms up
    arm_peak: float = 0.55     # min wrist height above shoulders at release (torso lengths)
    jump: float = 0.1          # min hip rise during the shot (torso lengths)
    model: str = "yolo11s-pose.pt"
    device: str | None = None  # mps, cpu, cuda (default: mps if available)
    analysis_fps: float = 30   # frames/sec to run pose on
    batch: int = 16


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


def detect_shots(times, sig, fps, params):
    """Return (shots, near_misses). Near misses pass looser thresholds but not the real ones."""
    arm, hip, torso = sig["arm"], sig["hip_y"], sig["torso"]
    n = len(times)
    s = lambda sec: int(round(sec * fps))
    shots, near = [], []
    for a, b in runs(np.nan_to_num(arm) > params.arm_up * MAYBE_SCALE):
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
        arms_up_long_enough = np.sum(arm[a:b] > params.arm_up) >= s(0.1)
        if arms_up_long_enough and cand["arm"] >= params.arm_peak and rise >= params.jump:
            if not shots or cand["release"] - shots[-1]["release"] >= 1.0:
                shots.append(cand)
        elif cand["arm"] >= params.arm_peak * MAYBE_SCALE and rise >= params.jump * MAYBE_SCALE:
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
