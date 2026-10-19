"""Pose pass: run a YOLO pose model over the video and track one player."""

import cv2
import numpy as np

from .paths import ROOT

LOST_TRACK_S = 1.0     # forget the tracked player after this long without a detection

_models = {}


def default_device():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def get_model(name):
    """Load a pose model once per process. Bare names download into the project folder."""
    from ultralytics import YOLO
    if name not in _models:
        _models[name] = YOLO(str(ROOT / name) if "/" not in name else name)
    return _models[name]


def pick_person(boxes, confs, prev_center):
    """Stick with the player nearest the last one we tracked, else the most confident."""
    centers = (boxes[:, :2] + boxes[:, 2:]) / 2
    if prev_center is not None:
        i = int(np.argmin(np.linalg.norm(centers - prev_center, axis=1)))
    else:
        i = int(np.argmax(confs))
    return i, centers[i]


def extract_pose(video, model_name, device, analysis_fps, batch, progress=None):
    """Keypoints for the tracked player in every analyzed frame.

    progress(frames_done, frames_total) is called as it goes.
    Returns (times, keypoints[N, 17, 3], analyzed fps).
    """
    model = get_model(model_name)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    stride = max(1, round(fps / analysis_fps))

    times, kps = [], []
    prev_center, last_seen = None, -1e9
    frames, frame_times = [], []
    idx = 0

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
        if progress and idx % 300 == 0 and total:
            progress(idx, total)
    if frames:
        flush()
    cap.release()
    if not times:
        raise RuntimeError("No frames could be read from the video")
    if progress:
        progress(total or idx, total or idx)
    return np.array(times), np.array(kps), fps / stride


def load_or_extract_pose(video, cache, model, device, analysis_fps, batch, fresh=False, progress=None):
    """Pose is the slow step, so save it and reuse it when re-running with new thresholds.

    Returns (times, keypoints, fps, used_cache).
    """
    key = f"{video.resolve()}|{video.stat().st_size}|{model}|{analysis_fps}"
    if cache.exists() and not fresh:
        c = np.load(cache)
        if str(c["key"]) == key:
            return c["times"], c["kps"], float(c["fps"]), True
    times, kps, fps = extract_pose(video, model, device, analysis_fps, batch, progress)
    np.savez_compressed(cache, times=times, kps=kps, fps=fps, key=key)
    return times, kps, fps, False
