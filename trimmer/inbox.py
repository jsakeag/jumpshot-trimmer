"""AirDrop inbox: move new iPhone videos from ~/Downloads (where AirDrop saves them) into data/.

Only takes iPhone camera originals (.MOV with Apple camera metadata) that weren't already
there the first time the inbox ran, so the rest of Downloads is left alone.
"""

import json
import shutil
import subprocess
import time
from pathlib import Path

from . import paths
from .export import probe

DEFAULT_FOLDER = Path.home() / "Downloads"
IGNORE_FILE = paths.ROOT / ".inbox_ignore.json"  # per folder, files to leave alone: present at first run, or not iPhone videos
SETTLE_S = 5                                      # a file must stop changing this long before it's taken


def is_iphone_original(tags):
    # Our own exports carry the copied Apple tags too, but ffmpeg also stamps an encoder tag.
    return tags.get("com.apple.quicktime.make") == "Apple" and "encoder" not in tags


def free_stem(stem):
    """A name not used by any video in data/ or results folder in out/."""
    taken = {p.stem for p in paths.DATA_DIR.glob("*")} | {p.name for p in paths.OUT_DIR.glob("*")}
    base, i = stem, 2
    while stem in taken:
        stem, i = f"{base}_{i}", i + 1
    return stem


class Inbox:
    def __init__(self, folder=DEFAULT_FOLDER):
        self.folder = Path(folder).expanduser()
        self.pending = {}  # name -> (size, mtime, first seen unchanged)
        self.error = None
        self.key = str(self.folder.resolve())
        saved = json.loads(IGNORE_FILE.read_text()) if IGNORE_FILE.exists() else {}
        if self.key in saved:
            self.ignore = set(saved[self.key])
        else:  # first run on this folder: leave everything already there alone
            self.ignore = {p.name for p in self._candidates()}
            self._save_ignore()

    def _save_ignore(self):
        saved = json.loads(IGNORE_FILE.read_text()) if IGNORE_FILE.exists() else {}
        saved[self.key] = sorted(self.ignore)
        IGNORE_FILE.write_text(json.dumps(saved, indent=1))

    def _candidates(self):
        try:
            files = [p for p in self.folder.iterdir() if p.suffix.lower() == ".mov" and not p.name.startswith(".")]
            self.error = None
            return files
        except PermissionError:
            self.error = (f"No permission to read {self.folder}. In System Settings → Privacy & Security → "
                          f"Files and Folders, allow your terminal app to access the Downloads folder.")
        except FileNotFoundError:
            self.error = f"{self.folder} doesn't exist"
        return []

    def scan(self):
        """Move any new, finished iPhone videos into data/. Returns their new paths."""
        imported = []
        now = time.time()
        for p in self._candidates():
            if p.name in self.ignore:
                continue
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            sig = (st.st_size, st.st_mtime)
            prev = self.pending.get(p.name)
            if not prev or prev[:2] != sig:
                self.pending[p.name] = (*sig, now)
                continue
            if now - prev[2] < SETTLE_S:
                continue
            try:
                tags = probe(p)[2]
            except (subprocess.CalledProcessError, KeyError, ValueError):
                continue  # not readable yet (still arriving); try again next scan
            del self.pending[p.name]
            if not is_iphone_original(tags):
                self.ignore.add(p.name)
                self._save_ignore()
                continue
            paths.DATA_DIR.mkdir(exist_ok=True)
            dest = paths.DATA_DIR / f"{free_stem(Path(paths.safe_name(p.name)).stem)}{p.suffix}"
            shutil.move(p, dest)
            imported.append(dest)
        return imported
