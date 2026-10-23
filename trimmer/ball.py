"""Ball tracking (experimental): known court points on the video and the ball clicked frame by
frame, stored in out/<video name>/ball.json, apart from the annotations:

    {court: {points: [{k, x, y}]} | null, slowmo: 1, tracks: [{id, points: [{t, x, y, ev}]}]}

court points are known spots on the court (k names one, e.g. near-base-dl, see LANDMARKS in
web/ballgeo.js) where they are on the video; x and y are fractions of the frame. ev is "hit"
(racket contact) or "bounce", or missing for the ball in flight. slowmo is how many times slower
than real time the video plays. The page fits the 3D flights itself (web/ballgeo.js); this only
keeps what was clicked.
"""

import json

from .paths import project_dir

EVENTS = ("hit", "bounce")


def ball_path(stem):
    return project_dir(stem) / "ball.json"


def load(stem):
    p = ball_path(stem)
    data = json.loads(p.read_text()) if p.exists() else {}
    return {"court": data.get("court"), "slowmo": data.get("slowmo", 1), "tracks": data.get("tracks", [])}


def clean(data):
    """Ball data from outside, checked and tidied. Raises ValueError."""
    f = lambda v: round(min(1.0, max(0.0, float(v))), 4)
    court = data.get("court")
    if court:
        court = {"points": [{"k": str(p["k"])[:24], "x": f(p["x"]), "y": f(p["y"])} for p in court.get("points", [])[:40]]}
    tracks = []
    for tr in data.get("tracks", [])[:200]:
        points = [{"t": round(max(0.0, float(p["t"])), 3), "x": f(p["x"]), "y": f(p["y"]),
                   **({"ev": p["ev"]} if p.get("ev") in EVENTS else {})} for p in tr.get("points", [])[:500]]
        tracks.append({"id": str(tr["id"])[:48], "points": sorted(points, key=lambda p: p["t"])})
    return {"court": court or None, "slowmo": min(32.0, max(1.0, float(data.get("slowmo") or 1))), "tracks": tracks}


def save(stem, data):
    data = clean(data)
    p = ball_path(stem)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(p)
    return data
