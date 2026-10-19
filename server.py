#!/usr/bin/env python3
"""Web app for the jumpshot trimmer. Run it, then open the printed link on your Mac or phone.

    .venv/bin/python server.py

Add videos by AirDropping them from your iPhone to this Mac: new iPhone videos that land in
Downloads are moved into data/. Shot-finding starts automatically for any new video in data/.

Anyone else on your Wi-Fi needs the key in the link to get in. Your own Mac doesn't.
"""

import argparse
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from trimmer import paths, project
from trimmer.inbox import DEFAULT_FOLDER, SETTLE_S, Inbox

WEB_DIR = paths.ROOT / "web"
KEY_FILE = paths.ROOT / ".web_key"

app = FastAPI()
executor = ThreadPoolExecutor(max_workers=1)  # one job at a time; the pose model wants the whole GPU
jobs = {}                                      # stem -> {"stage", "progress", "error"}
jobs_lock = threading.Lock()
inbox = None                                   # set in main()


def load_key():
    if not KEY_FILE.exists():
        KEY_FILE.write_text(secrets.token_urlsafe(9))
    return KEY_FILE.read_text().strip()


KEY = load_key()


@app.middleware("http")
async def require_key(request: Request, call_next):
    """Requests from this Mac are trusted. Others need ?key=... once, then a cookie."""
    if request.client and request.client.host in ("127.0.0.1", "::1"):
        return await call_next(request)
    if secrets.compare_digest(request.cookies.get("key", ""), KEY):
        return await call_next(request)
    if secrets.compare_digest(request.query_params.get("key", ""), KEY):
        response = await call_next(request)
        response.set_cookie("key", KEY, max_age=10 * 365 * 86400, httponly=True, samesite="lax")
        return response
    return PlainTextResponse("Open the link printed in the terminal; it includes the key.", status_code=403)


# ---------------------------------------------------------------- jobs

def start_job(stem, stage, fn):
    """Run fn(progress) in the background. Only one job per video at a time."""
    with jobs_lock:
        job = jobs.get(stem)
        if job and not job["error"]:
            raise HTTPException(409, f"{stem} is already {job['stage']}")
        job = jobs[stem] = {"stage": "queued", "next": stage, "progress": 0.0, "error": None}

    def run():
        job["stage"] = stage
        try:
            fn(lambda frac: job.__setitem__("progress", round(frac, 3)))
        except Exception as e:
            traceback.print_exc()
            job["error"] = str(e) or type(e).__name__
        else:
            with jobs_lock:
                jobs.pop(stem, None)

    executor.submit(run)


def start_detect(stem, video):
    start_job(stem, "detecting", lambda progress: project.detect(
        video, progress=lambda done, total: progress(done / total)))


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
    stem = video.stem
    s = {"name": video.name, "stem": stem, "job": jobs.get(stem), "clips": None}
    try:
        data = project.load(stem)
    except FileNotFoundError:
        return s
    final = data["final"] if project.final_path(stem).exists() else None
    s.update(clips=len(data["clips"]), maybes=sum(c["maybe"] for c in data["clips"]),
             dropped=len(data["dropped"]), final=final,
             final_current=bool(final and final["dropped"] == data["dropped"]))
    return s


def mac_name():
    try:
        return subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True,
                              check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return socket.gethostname().removesuffix(".local")


@app.get("/api/info")
def info(request: Request):
    return {"mac_name": mac_name(), "on_server_mac": from_server_mac(request),
            "inbox": str(inbox.folder) if inbox else None,
            "inbox_error": inbox.error if inbox else None}


def from_server_mac(request):
    """True for a browser on this Mac, whether it opened localhost or the Wi-Fi address."""
    host = request.client.host if request.client else None
    return host in ("127.0.0.1", "::1") or (host is not None and host == lan_ip())


@app.post("/api/reveal")
def reveal(request: Request, stem: str | None = None):
    """Show the out/ folder, or a video's final export, in Finder. Only from the Mac itself."""
    if not from_server_mac(request):
        raise HTTPException(403, "Only available on the Mac running the server")
    target = project.final_path(stem) if stem else paths.OUT_DIR
    if not target.exists():
        raise HTTPException(404, "Not exported yet" if stem else "No out folder yet")
    subprocess.run(["open", "-R", str(target)] if stem else ["open", str(target)], check=True)
    return {}


@app.get("/api/videos")
def list_videos():
    return [summary(v) for v in video_files()]


@app.get("/api/videos/{stem}")
def get_video(stem: str):
    video = video_for(stem)
    s = summary(video)
    if s["clips"] is not None:
        data = project.load(stem)
        s.update(clip_list=data["clips"], dropped_list=data["dropped"])
    return s


@app.post("/api/videos/{stem}/detect")
def detect(stem: str):
    start_detect(stem, video_for(stem))
    return summary(video_for(stem))


class Dropped(BaseModel):
    dropped: list[int]


@app.put("/api/videos/{stem}/dropped")
def set_dropped(stem: str, body: Dropped):
    try:
        project.set_dropped(stem, body.dropped)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))
    return summary(video_for(stem))


@app.post("/api/videos/{stem}/export")
def export(stem: str):
    video = video_for(stem)
    try:
        if not project.kept_clips(project.load(stem)):
            raise HTTPException(400, "Every clip is dropped.")
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    start_job(stem, "exporting", lambda progress: project.export_final(stem, progress=progress))
    return summary(video)


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
    """Make browsers (iPhone Safari especially) check for a newer app.js/style.css on every load."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", FreshStaticFiles(directory=WEB_DIR), name="static")


# ---------------------------------------------------------------- AirDrop inbox

def queue_new_videos(seen):
    """Start finding shots for any video in data/ without results, once it has finished copying."""
    now = time.time()
    for video in video_files():
        stem = video.stem
        if stem in jobs or project.clips_path(stem).exists():
            continue
        st = video.stat()
        sig = (st.st_size, st.st_mtime)
        prev = seen.get(stem)
        if not prev or prev[0] != sig:
            seen[stem] = (sig, now)
        elif now - prev[1] >= SETTLE_S:
            print(f"  New video: {video.name}, finding shots")
            start_detect(stem, video)


def watch():
    seen = {}
    while True:
        try:
            for video in inbox.scan():
                print(f"  AirDrop: moved {video.name} to data/")
            queue_new_videos(seen)
        except Exception:
            traceback.print_exc()
        time.sleep(3)


# ---------------------------------------------------------------- startup

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--inbox", type=Path, default=DEFAULT_FOLDER,
                   help="folder AirDrop saves to (default: ~/Downloads)")
    args = p.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")

    global inbox
    inbox = Inbox(args.inbox)
    if inbox.error:
        print(f"\n  Warning: {inbox.error}")
    threading.Thread(target=watch, daemon=True).start()
    print(f"\n  AirDrop videos to this Mac ({mac_name()}); new iPhone videos in {inbox.folder} move to data/.")

    print(f"\n  On this Mac:  http://localhost:{args.port}")
    ip = lan_ip()
    if ip:
        phone_url = f"http://{ip}:{args.port}/?key={KEY}"
        print(f"  On your phone (same Wi-Fi): {phone_url}\n")
        try:
            import qrcode
            qr = qrcode.QRCode(border=1)
            qr.add_data(phone_url)
            qr.print_ascii(invert=True)
            print("  Scan with your iPhone camera.\n")
        except ImportError:
            pass
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
