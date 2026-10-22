"""Tennis points anchored on serves, for a tighter cut than sound alone.

A serve is a player raising both arms (toss arm and racket arm) after standing fairly still.
Each serve starts a clip (2.5 s before the arms peak, to include the toss), and the clip runs
until the racket hits stop. Faults and lets become their own short clips, and the waiting
between serves and between points is cut.

The far player is small, so pose runs on a zoomed crop: a box the user draws around the far
baseline, with room above for the toss. The near player is whoever stands below that box.

Measured on one 48-minute session (11 labeled serves): every serve and every point ending kept,
3 false serves, 15.4 minutes kept (sound alone: 24.5). Takes roughly 0.8x the video's length to
process; the pose is cached, so changing the cut afterwards is quick.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .pose import default_device, get_model
from .tennis import TennisParams, hit_times, load_audio, racket_hits, SAMPLE_RATE

L_SH, R_SH, L_WR, R_WR, L_HIP, R_HIP, L_ANK, R_ANK = 5, 6, 9, 10, 11, 12, 15, 16


@dataclass
class ServeParams:
    arm: float = 0.3          # both wrists this far above the shoulders (torso lengths) = arms up
    still: float = 0.35       # max foot speed (body heights/s) in the 1.5 s before: servers set up
    pre: float = 2.5          # seconds kept before the arms peak (the toss)
    follow: float = 1.0       # seconds kept after the arms peak, for a serve on its own (the follow-through)
    post: float = 1.5         # seconds kept after the last hit
    gap: float = 4.5          # hits closer than this keep the point going
    contact: float = 8.0      # sound strength of a serve contact; a "serve" with none is marked maybe
    analysis_fps: float = 15
    imgsz: int = 1280
    model: str = "yolo11s-pose.pt"
    batch: int = 8


# ---------------------------------------------------------------- pose pass

def _best(r, ok):
    """Keypoints and box of the most confident detection that passes ok(box, feet_y)."""
    if r.keypoints is None or not len(r.boxes):
        return None
    boxes = r.boxes.xyxy.cpu().numpy(); conf = r.boxes.conf.cpu().numpy(); kps = r.keypoints.data.cpu().numpy()
    best = None
    for b, c, k in zip(boxes, conf, kps):
        ank = k[[L_ANK, R_ANK]]
        feet_y = ank[ank[:, 2] > 0.3, 1].max() if (ank[:, 2] > 0.3).any() else b[3]
        if ok(b, feet_y) and (best is None or c > best[0]):
            best = (c, k, b)
    return best


def extract_pose(video, box, params, progress=None):
    """Per analyzed frame, the near and far players' keypoints (full-frame pixels).

    box: (x0, y0, x1, y1) as fractions of the frame, around the far baseline.
    Returns dict of arrays: t, near_k, near_box, far_k, far_box.
    """
    model = get_model(params.model)
    device = default_device()
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open {video}")
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    stride = max(1, round(fps / params.analysis_fps))
    X0, Y0, X1, Y1 = int(box[0] * W), int(box[1] * H), int(box[2] * W), int(box[3] * H)
    cw, ch = X1 - X0, Y1 - Y0
    if cw < 50 or ch < 50:
        raise ValueError("The far-baseline box is too small")
    margin = 0.02 * ch

    def far_ok(b, feet_y):
        # fully inside the crop, so the near player poking in at an edge doesn't count
        return (b[0] > margin and b[2] < cw - margin and b[3] < ch - margin and b[3] - b[1] > 0.1 * ch)

    def near_ok(b, feet_y):
        return feet_y > Y1 and b[3] - b[1] > 0.05 * H

    out = {k: [] for k in ("t", "near_k", "near_box", "far_k", "far_box")}
    frames, crops, times = [], [], []
    empty_k, empty_b = np.full((17, 3), np.nan), np.full(4, np.nan)

    def flush():
        near = model.predict(frames, imgsz=params.imgsz, device=device, verbose=False, conf=0.15)
        far = model.predict(crops, imgsz=params.imgsz, device=device, verbose=False, conf=0.15)
        for t, rn, rf in zip(times, near, far):
            n = _best(rn, near_ok)
            f = _best(rf, far_ok)
            out["t"].append(t)
            out["near_k"].append(n[1] if n else empty_k); out["near_box"].append(n[2] if n else empty_b)
            if f:
                k = f[1].copy(); k[:, 0] += X0; k[:, 1] += Y0
                b = f[2] + [X0, Y0, X0, Y0]
                out["far_k"].append(k); out["far_box"].append(b)
            else:
                out["far_k"].append(empty_k); out["far_box"].append(empty_b)
        frames.clear(); crops.clear(); times.clear()

    idx = 0
    while True:
        if idx % stride:
            if not cap.grab():
                break
        else:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame); crops.append(frame[Y0:Y1, X0:X1]); times.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000)
            if len(frames) == params.batch:
                flush()
        idx += 1
        if progress and idx % 300 == 0 and total:
            progress(idx / total)
    if frames:
        flush()
    cap.release()
    if not out["t"]:
        raise RuntimeError("No frames could be read from the video")
    return {k: np.array(v, dtype=float) for k, v in out.items()} | {"fps": np.array(fps / stride)}


def load_or_extract_pose(video, box, params, cache, progress=None):
    key = f"{video.resolve()}|{video.stat().st_size}|{tuple(round(b, 4) for b in box)}|{params.analysis_fps}|{params.imgsz}|{params.model}"
    if cache.exists():
        c = np.load(cache)
        if str(c["key"]) == key:
            return {k: c[k] for k in c.files if k != "key"}
    pose = extract_pose(video, box, params, progress)
    np.savez_compressed(cache, key=key, **pose)
    return pose


# ---------------------------------------------------------------- serves and clips

def side_signals(k, box, fps):
    """(both-arms-up height in torso lengths, foot speed in body heights/s) per frame."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        xy = k[..., :2].copy()
        xy[k[..., 2] < 0.3] = np.nan
        sh = np.nanmean(xy[:, [L_SH, R_SH]], 1)
        hip = np.nanmean(xy[:, [L_HIP, R_HIP]], 1)
        torso = np.linalg.norm(sh - hip, axis=1)
        both_up = np.nanmin((sh[:, 1:2] - xy[:, [L_WR, R_WR], 1]) / torso[:, None], 1)
        feet = np.nanmean(xy[:, [L_ANK, R_ANK]], 1)
        height = box[:, 3] - box[:, 1]
        step = np.r_[np.nan, np.linalg.norm(np.diff(feet, axis=0), axis=1) / height[1:] * fps]
    return both_up, step


def find_serves(t, sides, params):
    """Times (arms peak) of serves from either player, at least 4 s apart."""
    import warnings
    found = []
    for both_up, step in sides:
        lo = np.nan_to_num(both_up, nan=-9)
        above = np.flatnonzero(lo > params.arm)
        if not len(above):
            continue
        for g in np.split(above, np.flatnonzero(np.diff(t[above]) > 0.7) + 1):
            i = g[np.argmax(lo[g])]
            pre = (t >= t[i] - 2) & (t <= t[i] - 0.5)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                stillness = np.nanmedian(step[pre])
            if stillness < params.still:
                found.append(float(t[i]))
    found.sort()
    serves = []
    for s in found:
        if not serves or s - serves[-1] > 4:
            serves.append(s)
    return serves


def clips_from_serves(serves, hits, contacts, duration, params):
    clips = []
    for k, s in enumerate(serves):
        nxt = serves[k + 1] if k + 1 < len(serves) else duration
        last = s
        for h in hits[(hits > s) & (hits < nxt - params.pre)]:
            if h - last > params.gap:
                break
            last = h
        heard = ((contacts >= s - 0.3) & (contacts <= s + 1.5)).any()
        clips.append({"start": round(max(0.0, s - params.pre), 3),
                      "end": round(min(duration, max(last, s + 1) + params.post), 3),
                      "maybe": not heard})
    merged = []
    for c in clips:  # overlapping clips (a quick re-serve) become one
        if merged and c["start"] <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], c["end"])
            merged[-1]["maybe"] = merged[-1]["maybe"] and c["maybe"]
        else:
            merged.append(c)
    return merged


def _serves_and_audio(video, box, cache, params, progress):
    pose = load_or_extract_pose(video, box, params, cache, progress)
    samples = load_audio(video)
    t, fps = pose["t"], float(pose["fps"])
    sides = [side_signals(pose[f"{s}_k"], pose[f"{s}_box"], fps) for s in ("near", "far")]
    return find_serves(t, sides, params), samples


def detect_points(video, box, cache, params=None, tennis=None, progress=None):
    """Serve-anchored clips ({start, end, maybe}). progress(fraction) covers the pose pass."""
    params = params or ServeParams()
    tennis = tennis or TennisParams()
    serves, samples = _serves_and_audio(video, box, cache, params, progress)
    duration = len(samples) / SAMPLE_RATE
    return clips_from_serves(serves, racket_hits(samples, tennis), hit_times(samples, params.contact), duration, params)


def detect_serves(video, box, cache, params=None, progress=None):
    """Each serve on its own ({start, end, maybe}), from the toss to the follow-through. A serve
    with no contact heard is a maybe. progress(fraction) covers the pose pass."""
    params = params or ServeParams()
    serves, samples = _serves_and_audio(video, box, cache, params, progress)
    duration = len(samples) / SAMPLE_RATE
    contacts = hit_times(samples, params.contact)
    return [{"start": round(max(0.0, s - params.pre), 3), "end": round(min(duration, s + params.follow), 3),
             "maybe": not ((contacts >= s - 0.3) & (contacts <= s + 1.5)).any()} for s in serves]
