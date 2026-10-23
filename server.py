#!/usr/bin/env python3
"""Web app: annotate strokes on a session video, tag and score them, and export the confirmed ones.

    .venv/bin/python server.py

Then open http://localhost:8000. Put videos in data/.
"""

import argparse
import json
import shutil
import subprocess
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from trimmer import ball, media, paths, plugins, project
from trimmer.export import frame_rate, probe

WEB_DIR = paths.ROOT / "web"
SETTINGS_FILE = paths.ROOT / ".settings.json"  # outside out/, so Clear all keeps it

app = FastAPI()
executor = ThreadPoolExecutor(max_workers=1)        # plugins and exports; the pose model wants the whole GPU
media_executor = ThreadPoolExecutor(max_workers=1)  # filmstrips and waveforms, so they don't wait behind a plugin
jobs = {}        # stem -> {"stage", "label", "progress", "error", "result"}
media_jobs = {}  # stem -> None while making, else why it failed
jobs_lock = threading.Lock()


# ---------------------------------------------------------------- jobs

def start_job(stem, stage, label, fn):
    """Run fn(progress) in the background. Only one job per video at a time. A finished job stays
    listed with its result until the next one starts, so the page can tell it ended."""
    with jobs_lock:
        job = jobs.get(stem)
        if job and not job["error"] and job["stage"] != "done":
            raise HTTPException(409, f"{stem} is already {job['label'].lower()}")
        job = jobs[stem] = {"stage": "queued", "next": stage, "label": label, "progress": 0.0, "error": None,
                            "result": None}

    def run():
        job["stage"] = stage
        try:
            job["result"] = fn(lambda frac: job.__setitem__("progress", round(frac, 3)))
        except Exception as e:
            traceback.print_exc()
            job["error"] = str(e) or type(e).__name__
        else:
            job["stage"] = "done"

    executor.submit(run)


def busy():
    return any(not j["error"] and j["stage"] != "done" for j in jobs.values()) or any(
        e is None for e in media_jobs.values())


def load_settings():
    return json.loads(SETTINGS_FILE.read_text()) if SETTINGS_FILE.exists() else {}


# ---------------------------------------------------------------- videos

def video_files():
    if not paths.DATA_DIR.exists():
        return []
    files = [p for p in paths.DATA_DIR.iterdir() if p.suffix.lower() in paths.VIDEO_EXTS]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def video_for(stem):
    for p in video_files():
        if p.stem == stem:
            return p
    try:  # a video the CLI ran on from outside data/
        p = Path(project.load(stem)["video"])
        if p.exists():
            return p
    except FileNotFoundError:
        pass
    raise HTTPException(404, f"No video named {stem}")


def summary(video):
    """What the video list shows. Reads only the project file, never the video."""
    stem = video.stem
    s = {"name": video.name, "stem": stem, "job": jobs.get(stem), "annotations": 0, "maybes": 0, "exported": False}
    try:
        data = project.load(stem)
    except FileNotFoundError:
        return s
    maybes = sum(a["maybe"] for a in data["annotations"])
    s.update(annotations=len(data["annotations"]) - maybes, maybes=maybes, exported=project.final_current(data))
    return s


def status(stem, data):
    final = data["final"] if data["final"] and project.final_path(stem).exists() else None
    return {"rev": data["rev"], "job": jobs.get(stem), "final": final,
            "final_current": bool(final) and project.final_current(data)}


@app.get("/api/info")
def info():
    return {"plugins": [p.info() for p in plugins.PLUGINS.values()], "kinds": project.KIND_LABEL,
            "last_far_box": load_settings().get("far_box"), "data_dir": str(paths.DATA_DIR)}


@app.post("/api/reveal")
def reveal(stem: str | None = None):
    """Show a video's final export in Finder, or open the data folder."""
    if stem:
        target = project.final_path(stem)
        if not target.exists():
            raise HTTPException(404, "Not exported yet")
        subprocess.run(["open", "-R", str(target)], check=True)
    else:
        paths.DATA_DIR.mkdir(exist_ok=True)
        subprocess.run(["open", str(paths.DATA_DIR)], check=True)
    return {}


@app.post("/api/clear")
def clear_all():
    """Move everything in data/ and out/ to the Trash (recoverable with Put Back)."""
    if busy():
        raise HTTPException(409, "Wait for plugins and exports to finish first.")
    items = [p for d in (paths.DATA_DIR, paths.OUT_DIR) if d.exists() for p in d.iterdir()]
    if items:
        subprocess.run(["trash", *map(str, items)], check=True)
    jobs.clear()
    media_jobs.clear()
    return {"trashed": len(items)}


@app.get("/api/videos")
def list_videos():
    return [summary(v) for v in video_files()]


VOCABS = {"labels": "tag names", "steps": "footwork step names", "splits": "split-step foot names"}


def check_kind(kind):
    if kind not in VOCABS:
        raise HTTPException(404, f"No list called {kind}")


def clean_name(name):
    name = " ".join(name.split())[:60]
    if not name:
        raise HTTPException(400, "It needs a name")
    return name


def vocab(kind):
    """The names to pick from for tags (labels) or steps: every one created or used in any video,
    most used first, with how often each is used, its color (if one was picked) and whether it's
    marked bad (a step that ideally isn't needed) or good."""
    settings = load_settings()
    counts = {name: 0 for name in settings.get(kind, [])}
    for p in paths.OUT_DIR.glob("*/project.json") if paths.OUT_DIR.exists() else []:
        for a in json.loads(p.read_text()).get("annotations", []):
            for name in project.names_in(kind, a):
                counts[name] = counts.get(name, 0) + 1
    colors = settings.get("colors", {}).get(kind, {})
    bad = set(settings.get("bad", {}).get(kind, []))
    good = set(settings.get("good", {}).get(kind, []))
    return [{"name": n, "count": counts[n], "color": colors.get(n), "bad": n in bad, "good": n in good}
            for n in sorted(counts, key=lambda k: (-counts[k], k.lower()))]


def save_vocab(kind, update):
    """update(names, colors, bad, good) changes this kind's saved names, colors, and bad and good
    names in place."""
    settings = load_settings()
    names = settings.get(kind, [])
    colors = settings.setdefault("colors", {}).setdefault(kind, {})
    bad = settings.setdefault("bad", {}).setdefault(kind, [])
    good = settings.setdefault("good", {}).setdefault(kind, [])
    update(names, colors, bad, good)
    settings[kind] = names
    SETTINGS_FILE.write_text(json.dumps(settings))


@app.get("/api/vocab/{kind}")
def get_vocab(kind: str):
    check_kind(kind)
    return vocab(kind)


class Name(BaseModel):
    name: str


@app.post("/api/vocab/{kind}")
def add_to_vocab(kind: str, body: Name):
    """Add a name to pick from, before anything uses it."""
    check_kind(kind)
    name = clean_name(body.name)
    save_vocab(kind, lambda names, colors, bad, good: None if any(n.lower() == name.lower() for n in names) else names.append(name))
    return vocab(kind)


class NameChange(BaseModel):
    name: str
    new_name: str | None = None
    color: str | None = None
    bad: bool | None = None
    good: bool | None = None


@app.patch("/api/vocab/{kind}")
def change_vocab(kind: str, body: NameChange):
    """Rename a name everywhere it's used (into another existing name merges them), set its color,
    or mark it bad or good or neither."""
    check_kind(kind)
    if body.color is not None:
        save_vocab(kind, lambda names, colors, bad, good: colors.__setitem__(body.name, body.color[:20]))
    if body.bad is not None or body.good is not None:
        def mark(names, colors, bad, good):
            for marked, on in ((bad, body.bad), (good, body.good)):
                if on is not None:
                    marked[:] = [n for n in marked if n != body.name] + ([body.name] if on else [])
            if body.name not in names:  # keep it listed even if nothing uses it any more
                names.append(body.name)
        save_vocab(kind, mark)
    if body.new_name is not None:
        new = clean_name(body.new_name)
        if new != body.name:
            project.rename_everywhere(kind, body.name, new)

            def update(names, colors, bad, good):
                names[:] = [new if n == body.name else n for n in names if n != new] + ([] if body.name in names else [new])
                if body.name in colors:
                    colors.setdefault(new, colors.pop(body.name))
                for marked in (bad, good):
                    if body.name in marked:
                        marked[:] = [n for n in marked if n not in (body.name, new)] + [new]
            save_vocab(kind, update)
    return vocab(kind)


@app.delete("/api/vocab/{kind}")
def delete_from_vocab(kind: str, name: str):
    """Delete a name from the list and from everything that uses it."""
    check_kind(kind)
    project.rename_everywhere(kind, name, None)

    def update(names, colors, bad, good):
        names[:] = [n for n in names if n != name]
        colors.pop(name, None)
        bad[:] = [n for n in bad if n != name]
        good[:] = [n for n in good if n != name]
    save_vocab(kind, update)
    return vocab(kind)


@app.get("/api/videos/{stem}")
def get_video(stem: str):
    video = video_for(stem)
    duration, has_audio, _ = probe(video)
    num, _, den = frame_rate(video).partition("/")
    data = project.load(stem, video)
    return {"name": video.name, "stem": stem, "duration": duration, "has_audio": has_audio,
            "fps": float(num) / float(den or 1), "annotations": data["annotations"], "plugins": data["plugins"],
            **status(stem, data)}


@app.get("/api/videos/{stem}/status")
def get_status(stem: str):
    return status(stem, project.load(stem, video_for(stem)))


class Annotations(BaseModel):
    base_rev: int
    annotations: list[dict]


@app.put("/api/videos/{stem}/annotations")
def save_annotations(stem: str, body: Annotations):
    try:
        data, added, removed = project.save_annotations(stem, video_for(stem), body.base_rev, body.annotations)
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, f"Couldn't save: {e}")
    return {**status(stem, data), "added": added, "removed": removed}


@app.get("/api/videos/{stem}/ball")
def get_ball(stem: str):
    """Court corners and ball tracks (experimental)."""
    video_for(stem)
    return ball.load(stem)


@app.put("/api/videos/{stem}/ball")
def save_ball(stem: str, body: dict):
    video_for(stem)
    try:
        return ball.save(stem, body)
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, f"Couldn't save: {e}")


@app.post("/api/videos/{stem}/plugins/{name}")
def run_plugin(stem: str, name: str, options: dict):
    video = video_for(stem)
    try:
        plugin = plugins.get(name)
        options = plugin.check(options)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if "far_box" in options:  # prefill the box next time
        SETTINGS_FILE.write_text(json.dumps({**load_settings(), "far_box": options["far_box"]}))
    start_job(stem, "running", plugin.label, lambda progress: {
        "added": project.run_plugin(video, name, options, progress)[1]})
    return status(stem, project.load(stem, video))


@app.post("/api/videos/{stem}/export")
def export(stem: str):
    video = video_for(stem)
    data = project.load(stem, video)
    if not project.confirmed_windows(data):
        raise HTTPException(400, "Nothing confirmed to export.")
    start_job(stem, "exporting", "Export", lambda progress: {"clips": len(project.export_final(stem, progress)[1])})
    return status(stem, data)


@app.get("/api/videos/{stem}/media")
def get_media(stem: str):
    """Filmstrip and loudness info, or {"pending": true} while they're made (started on first ask)."""
    video = video_for(stem)
    info = media.load_info(stem)
    if info:
        return info
    with jobs_lock:
        state = media_jobs.get(stem, "new")
        if state == "new":
            media_jobs[stem] = None
            media_executor.submit(make_media, stem, video)
        elif state is not None:  # failed: report it, and try again on the next ask
            del media_jobs[stem]
            return {"error": state}
    return {"pending": True}


def make_media(stem, video):
    try:
        media.make(video)
        media_jobs.pop(stem, None)
    except Exception as e:
        traceback.print_exc()
        media_jobs[stem] = str(e) or type(e).__name__


@app.get("/api/videos/{stem}/filmstrip.jpg")
def filmstrip(stem: str):
    video_for(stem)
    return FileResponse(media.filmstrip_path(stem), media_type="image/jpeg")


@app.get("/api/videos/{stem}/wave.bin")
def wave(stem: str):
    video_for(stem)
    return FileResponse(media.wave_path(stem), media_type="application/octet-stream")


@app.get("/api/videos/{stem}/source")
def source(stem: str):
    # served as mp4 so Chrome will play .mov files too
    return FileResponse(video_for(stem), media_type="video/mp4")


@app.get("/api/videos/{stem}/final")
def final(stem: str):
    video_for(stem)
    path = project.final_path(stem)
    if not path.exists():
        raise HTTPException(404, "Not exported yet")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


class FreshStaticFiles(StaticFiles):
    """Make the browser check for a newer app.js/style.css on every load."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", FreshStaticFiles(directory=WEB_DIR), name="static")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    paths.DATA_DIR.mkdir(exist_ok=True)
    print(f"\n  Open http://localhost:{args.port}\n  Videos go in {paths.DATA_DIR}\n")
    # restarts itself when the Python code changes (a plugin or export running then is stopped)
    uvicorn.run("server:app", host="127.0.0.1", port=args.port, log_level="warning", reload=True,
                reload_dirs=[str(paths.ROOT)], reload_excludes=[".venv/*", "data/*", "out/*", "exp/*"])


if __name__ == "__main__":
    main()
