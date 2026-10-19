# Jumpshot Trimmer

Cuts a basketball session video down to just your shots (jumpshots and layups).
Each clip runs from 0.5 s before the gather to 0.5 s after release.

It works in two passes:

1. **Detect**: a pose model finds every shot. It leans toward including too much:
   borderline moments are kept and labeled **maybe**, so nothing is cut without you seeing it.
2. **Review**: you watch the clips, drop the ones that aren't shots, and export the final video.

You can use it from a web app (on your Mac or your phone) or from the command line.

## Setup (once)

Requires macOS with [Homebrew](https://brew.sh) and Python 3.11+.

```sh
brew install ffmpeg
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The pose model (`yolo11s-pose.pt`) downloads automatically on the first run.

## Filming tips

- Phone on the floor behind the hoop, facing the court, not moving.
- Works best with just you in frame.

## Web app

```sh
.venv/bin/python server.py
```

It prints two links and a QR code:

- **On your Mac**: open `http://localhost:8000`.
- **On your iPhone** (same Wi-Fi as the Mac): scan the QR code with the camera.
  The link includes a private key; after opening it once, your phone stays signed in.
  The first time, macOS may ask whether Python can accept incoming connections. Click Allow.

Your Mac does all the work, so keep the server running until you're done.

### Adding videos: AirDrop

On your iPhone, open Photos, select your session videos, tap **Share → AirDrop**, and pick your Mac.

AirDrop saves them to your Mac's Downloads folder. The server moves new iPhone videos from there
into `data/` within a few seconds, and finding shots starts automatically, one video at a time
(about 4 minutes for a 9-minute video the first time). AirDrop sends the full-quality original,
so long videos, capture date and location all come through intact.

It only moves iPhone camera originals (`.MOV`) that arrive after the server first ran, so the
rest of your Downloads is left alone. To add a video that was already there, move it into `data/`
yourself; anything new in `data/` gets analyzed automatically.

If macOS asks whether your terminal can access the Downloads folder, click Allow. (If you missed
it: System Settings → Privacy & Security → Files and Folders.) To watch a different folder, run
`server.py --inbox <folder>`.

### Reviewing and exporting

1. **Review.** Open a video. Tap a clip to play it. With *Auto-play next clip* on, it plays
   straight through. Tap **Keeping · tap to drop** for anything that isn't a shot. The **Maybes**
   filter shows only the borderline clips. Your picks save automatically.
2. **Export final video.** It's saved as `out/<name>/<name>_final.mp4`.
3. **Get it onto your iPhone with AirDrop.** On the Mac, click **Show in Finder** (or **Open out
   folder in Finder** on the home screen), then right-click the video → Share → AirDrop → your
   iPhone. The export keeps the original's capture date, so it lands in Photos on the day you
   filmed it. (From the phone you can also tap **Download**, then open it from Safari's
   downloads and Share → Save Video.)

On a Mac keyboard: space plays/pauses, ← → move between clips, D drops/keeps.

When you're done, **Clear all videos** (bottom of the home page) moves everything in `data/` and
`out/` to the Trash. Your originals stay in your iPhone's Photos.

## Command line

Put your video in `data/`, e.g. `data/IMG_0121.MOV`.

```sh
.venv/bin/python cli.py detect IMG_0121.MOV      # pass 1
.venv/bin/python cli.py trim IMG_0121 1,24,27    # pass 2
```

`detect` creates `out/IMG_0121/IMG_0121_review.mp4` with every clip numbered:
subtitles show `Clip 7 · 2:16 in original` (or `Clip 7 (maybe) · …`), and chapters let you jump
between clips. In QuickTime Player, turn subtitles on under View > Subtitles > English, and use
View > Show Chapters or Shift-⌘-→ / ← to move between clips.

`trim` creates `out/IMG_0121/IMG_0121_final.mp4` without the clips you list. Ranges work too:
`3,7,10-12`. Clip numbers always refer to the review video, so to change your mind, run `trim`
again with the full list. The final video has no captions or chapters, so it's clean to share.

The web app and the command line share the same results, so you can mix them.

## Output files

All results go in `out/<video name>/`:

| File | What it is |
| --- | --- |
| `<name>_final.mp4` | The final video: kept clips, with the original's date and location |
| `<name>_review.mp4` | Every clip, numbered (command line only) |
| `clips.json` | Clip times in the original video, and which ones you dropped |
| `pose.npz` | Cached pose data, so re-running detection takes seconds |

## Project layout

| Path | What it is |
| --- | --- |
| `trimmer/` | The core, shared by both front ends: pose (`pose.py`), shot detection (`detect.py`), ffmpeg export (`export.py`), per-video results (`project.py`), AirDrop inbox (`inbox.py`) |
| `server.py`, `web/` | The web app: API server and the page it serves |
| `cli.py` | The command line |

## Tuning detection

If it misses shots or picks up too much junk, adjust these `cli.py detect` options
(all measured in torso lengths, so they work at any distance from the camera):

| Option | Default | Meaning |
| --- | --- | --- |
| `--arm-peak` | 0.55 | How high the wrist must get above the shoulders at release. Lower catches more. |
| `--arm-up` | 0.4 | Wrist height that counts as "arms up". |
| `--jump` | 0.1 | How much the hips must rise. Lower catches more. |
| `--pre` / `--post` | 0.5 | Seconds kept before the gather / after release. |

Other options: `--dry-run` (list clips without exporting), `--fresh` (redo pose detection),
`--debug` (write per-frame signals to `signals.csv`). Run `.venv/bin/python cli.py detect -h`
for the full list. The defaults live in `DetectParams` in `trimmer/detect.py`, which the web app uses.
