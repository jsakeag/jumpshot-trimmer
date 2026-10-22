"""A video's project: its annotations and exports, stored in out/<video name>/project.json.

An annotation is a window of the video:
    {id, kind, start, end, maybe, tags: [{name, score}], source, drawings}
kind is a stroke (fh, bh, serve) or what a plugin finds (point, shot). Windows you mark
are confirmed; ones a plugin finds come in as maybe until you confirm them. Each tag has a score
from 1 to 5 for how strongly it shows. drawings are footwork marked on the video for that stroke:
steps ({type: point, x, y, tie, name}, where tie means it lands together with the step before) and the feet at the split step ({type: split, x, y}), as fractions of the frame. Exporting joins the confirmed windows.

The web page saves the whole list at once, while a plugin may be adding to it in the background,
so saves are merged: every change bumps rev, and a save based on an older rev keeps what was
added since (and drops what a plugin replaced) instead of overwriting it.

This is the API the CLI and the web app share.
"""

import json
import threading
from pathlib import Path

from .export import export, timeline
from .paths import OUT_DIR, project_dir
from . import plugins

KINDS = ("fh", "bh", "serve", "point", "shot")
FOOTWORK_KINDS = ("fh", "bh")  # footwork can only be drawn on these
KIND_LABEL = {"fh": "Forehand", "bh": "Backhand", "serve": "Serve",
              "point": "Point", "shot": "Shot"}
MAX_TOMBSTONES = 2000

_lock = threading.RLock()  # project.json is read-modify-written from web requests and jobs


def project_path(stem):
    return project_dir(stem) / "project.json"


def review_path(stem):
    return project_dir(stem) / f"{stem}_review.mp4"


def final_path(stem):
    return project_dir(stem) / f"{stem}_final.mp4"


def load(stem, video=None):
    """The project, or a new empty one for video if there isn't one yet."""
    p = project_path(stem)
    if not p.exists():
        if video is None:
            raise FileNotFoundError(f"No project for {stem}")
        return {"video": str(video), "rev": 0, "score_scale": 5, "annotations": [], "tombstones": [], "plugins": {}, "final": None}
    data = json.loads(p.read_text())
    for k, v in (("rev", 0), ("annotations", []), ("tombstones", []), ("plugins", {}), ("final", None)):
        data.setdefault(k, v)
    if data.get("score_scale") != 5:  # tags used to be scored 0-10: map it onto 1-5
        for a in data["annotations"]:
            for t in a["tags"]:
                t["score"] = min(5, max(1, int(1 + t["score"] * 0.4 + 0.5)))
        data["score_scale"] = 5
    for a in data["annotations"]:  # volleys used to be their own kinds (fhv, bhv); now they're a tag
        if a["kind"] in ("fhv", "bhv"):
            a["kind"] = a["kind"][:2]
            if not any(t["name"] == "volley" for t in a["tags"]):
                a["tags"].append({"name": "volley", "score": 5})
    return data


def save(stem, data):
    p = project_path(stem)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(p)


def clean(a):
    """An annotation from outside, checked and tidied. Raises ValueError."""
    if a.get("kind") not in KINDS:
        raise ValueError(f"Unknown kind {a.get('kind')!r}")
    start, end = round(max(0.0, float(a["start"])), 3), round(float(a["end"]), 3)
    if end - start < 0.05:
        raise ValueError(f"Annotation {a['id']} is empty")
    tags, seen = [], set()
    for t in a.get("tags", []):
        name = " ".join(str(t["name"]).split())[:60]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            tags.append({"name": name, "score": min(5, max(1, round(float(t.get("score", 3)))))})
    out = {"id": str(a["id"])[:48], "kind": a["kind"], "start": start, "end": end, "maybe": bool(a.get("maybe")),
           "tags": tags, "source": str(a.get("source") or "manual")[:32]}
    if a.get("weak"):
        out["weak"] = True
    drawings = []
    for d in a.get("drawings", [])[:60]:  # footwork on the video: steps and split-step feet
        f = lambda k: round(min(1.0, max(0.0, float(d[k]))), 4)
        if d.get("type") in ("point", "split"):
            name = " ".join(str(d.get("name") or "").split())[:60]
            drawings.append({"type": d["type"], "x": f("x"), "y": f("y"), **({"tie": True} if d.get("tie") else {}),
                             **({"name": name} if name else {})})
    if drawings and out["kind"] in FOOTWORK_KINDS:
        out["drawings"] = drawings
    return out


def save_annotations(stem, video, base_rev, annotations):
    """Replace the annotations with the page's list, keeping what was added since base_rev.

    Returns (data, added, removed): annotations the page hasn't seen yet, and ids it has that
    were replaced since.
    """
    annotations = [clean(a) for a in annotations]
    with _lock:
        data = load(stem, video)
        ids = {a["id"] for a in annotations}
        if len(ids) != len(annotations):
            raise ValueError("Duplicate annotation ids")
        gone = {t["id"] for t in data["tombstones"] if t["rev"] > base_rev}
        removed = sorted(ids & gone)
        added = [a for a in data["annotations"] if a.get("added_rev", 0) > base_rev and a["id"] not in ids]
        prev_rev = {a["id"]: a.get("added_rev", 0) for a in data["annotations"]}
        data["rev"] += 1
        kept = [{**a, "added_rev": prev_rev.get(a["id"], data["rev"])} for a in annotations if a["id"] not in gone]
        data["annotations"] = sorted(kept + added, key=lambda a: a["start"])
        save(stem, data)
        return data, added, removed


def run_plugin(video, name, options=None, progress=None):
    """Run a plugin and add what it finds as maybes, replacing its earlier untouched maybes
    (still maybe and untagged). progress(fraction) reports progress. Returns (data, number added)."""
    plugin = plugins.get(name)
    options = plugin.check(options or {})
    stem = video.stem
    out_dir = project_dir(stem)
    out_dir.mkdir(parents=True, exist_ok=True)
    found = plugin.run(video, out_dir, options, progress)
    with _lock:
        data = load(stem, video)
        data["rev"] += 1
        rev = data["rev"]
        old = [a for a in data["annotations"] if a["source"] == name and a["maybe"] and not a["tags"]]
        old_ids = {a["id"] for a in old}
        data["annotations"] = [a for a in data["annotations"] if a["id"] not in old_ids]
        data["tombstones"] = (data["tombstones"] + [{"id": i, "rev": rev} for i in sorted(old_ids)])[-MAX_TOMBSTONES:]
        new = [{"id": f"{name}-{rev}-{i}", "kind": plugin.kind, "start": f["start"], "end": f["end"], "maybe": True,
                "tags": [], "source": name, "added_rev": rev, **({"weak": True} if f.get("weak") else {})}
               for i, f in enumerate(found, 1)]
        data["annotations"] = sorted(data["annotations"] + new, key=lambda a: a["start"])
        data["plugins"][name] = options
        save(stem, data)
    return data, len(new)


def confirmed_windows(data):
    """The confirmed annotations as time windows, in order, with overlaps joined."""
    out = []
    for a in sorted((a for a in data["annotations"] if not a["maybe"]), key=lambda a: a["start"]):
        if out and a["start"] <= out[-1]["end"]:
            out[-1]["end"] = max(out[-1]["end"], a["end"])
        else:
            out.append({"start": a["start"], "end": a["end"]})
    return out


def final_current(data):
    """Whether the last export matches the confirmed annotations as they are now."""
    return bool(data["final"]) and data["final"]["windows"] == confirmed_windows(data)


def export_final(stem, progress=None):
    """The confirmed windows joined into one clean video. Returns (path, clips)."""
    data = load(stem)
    windows = confirmed_windows(data)
    if not windows:
        raise ValueError("Nothing confirmed to export.")
    clips = timeline([{"n": n, **w, "maybe": False} for n, w in enumerate(windows, 1)])
    out = final_path(stem)
    export(Path(data["video"]), clips, out, labels=False, progress=progress)
    with _lock:
        latest = load(stem)
        latest["final"] = {"windows": windows, "clips": len(clips), "duration": clips[-1]["reel_end"]}
        save(stem, latest)
    return out, clips


def export_review(stem, progress=None):
    """Every annotation, maybes included, labeled with subtitles and chapters."""
    data = load(stem)
    anns = sorted(data["annotations"], key=lambda a: a["start"])
    if not anns:
        raise ValueError("No annotations to export.")
    clips = timeline([{"n": n, "start": a["start"], "end": a["end"], "maybe": a["maybe"],
                       "label": KIND_LABEL[a["kind"]]} for n, a in enumerate(anns, 1)])
    out = review_path(stem)
    export(Path(data["video"]), clips, out, labels=True, progress=progress)
    return out


# ---------------------------------------------------------------- names across all projects
# kind "labels" is tag names, "steps" footwork step names, "splits" split-step foot names.

DRAWING_TYPE = {"steps": "point", "splits": "split"}


def names_in(kind, annotation):
    if kind == "labels":
        return [t["name"] for t in annotation["tags"]]
    return [d["name"] for d in annotation.get("drawings", []) if d.get("name") and d["type"] == DRAWING_TYPE[kind]]


def rename_everywhere(kind, old, new=None):
    """Rename a tag or step name in every project, or with new=None, remove it (tags are taken off;
    steps keep their place but lose the name). Returns how many uses changed."""
    changed = 0
    for p in OUT_DIR.glob("*/project.json") if OUT_DIR.exists() else []:
        stem = p.parent.name
        with _lock:
            data = load(stem)
            n = 0
            for a in data["annotations"]:
                if kind == "labels":
                    tags = []
                    for t in a["tags"]:
                        if t["name"] == old:
                            n += 1
                            if new is None:
                                continue
                            t = {**t, "name": new}
                        same = next((x for x in tags if x["name"].lower() == t["name"].lower()), None)
                        if same:  # renamed onto a tag it already had: keep the stronger score
                            same["score"] = max(same["score"], t["score"])
                        else:
                            tags.append(t)
                    a["tags"] = tags
                else:
                    for d in a.get("drawings", []):
                        if d.get("name") == old and d["type"] == DRAWING_TYPE[kind]:
                            n += 1
                            if new is None:
                                del d["name"]
                            else:
                                d["name"] = new
            if n:
                data["rev"] += 1
                save(stem, data)
                changed += n
    return changed

