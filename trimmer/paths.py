import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"   # input videos
OUT_DIR = ROOT / "out"     # results go to out/<video name>/
VIDEO_EXTS = {".mov", ".mp4", ".m4v"}


def project_dir(stem):
    return OUT_DIR / stem


def find_video(path):
    """A path as given, or a bare filename looked up in data/."""
    path = Path(path)
    if not path.exists() and (DATA_DIR / path).exists():
        path = DATA_DIR / path
    if not path.exists():
        raise FileNotFoundError(f"No such file: {path} (put videos in {DATA_DIR})")
    return path.resolve()


def safe_name(name):
    """A filename that's safe to store in data/: no folders, no odd characters."""
    name = re.sub(r"[^\w.\- ]", "_", Path(name).name).strip(" .")
    return name or "video.mov"
