# Jumpshot Trimmer

Cuts a basketball session video down to just your shots (jumpshots and layups).
Each clip runs from 0.5 s before the gather to 0.5 s after release.

It works in two passes:

1. **detect**: a pose model finds every shot and exports a numbered review video.
2. **trim**: you watch the review and list the clips to drop; it exports the final video.

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

## Usage

Put your video in `data/`, e.g. `data/IMG_0121.MOV`.

### Pass 1: detect

```sh
.venv/bin/python jumpshot_trimmer.py detect IMG_0121.MOV
```

This creates `out/IMG_0121/IMG_0121_review.mp4`, containing every shot it found.
It leans toward including too much: borderline moments are kept and labeled
**(maybe)**, so nothing is cut without you seeing it.

The first run on a video takes a few minutes (about 4 min for a 9-minute video).
After that the pose data is cached, so re-running takes seconds plus the export.

### Watch the review video

Every clip is numbered. In QuickTime Player:

- **Subtitles** show `Clip 7 · 2:16 in original` (`Clip 7 (maybe) · …` for borderline ones).
  If they're hidden, turn them on under View > Subtitles > English.
- **Chapters**: use View > Show Chapters, or Shift-⌘-→ / ← to jump between clips.

Write down the numbers of any clips that aren't shots.

### Pass 2: trim

```sh
.venv/bin/python jumpshot_trimmer.py trim IMG_0121 1,24,27
```

This creates `out/IMG_0121/IMG_0121_final.mp4` without those clips. Ranges work too: `3,7,10-12`.
The final video has no captions or chapters, so it's clean to AirDrop or share.

Clip numbers always refer to the review video, so to change your mind, run `trim`
again with the full list. Each run replaces the previous final video.

## Output files

All results go in `out/<video name>/`:

| File | What it is |
| --- | --- |
| `<name>_review.mp4` | Pass 1 video: every detected clip, numbered |
| `<name>_final.mp4` | Pass 2 video: review minus the clips you dropped |
| `clips.json` | Clip times in the original video (used by `trim`) |
| `pose.npz` | Cached pose data, so re-runs skip the slow step |
| `*.srt`, `*.chapters.txt` | Clip labels embedded in the review video |

## Tuning detection

If it misses shots or picks up too much junk, adjust these `detect` options
(all measured in torso lengths, so they work at any distance from the camera):

| Option | Default | Meaning |
| --- | --- | --- |
| `--arm-peak` | 0.55 | How high the wrist must get above the shoulders at release. Lower catches more. |
| `--arm-up` | 0.4 | Wrist height that counts as "arms up". |
| `--jump` | 0.1 | How much the hips must rise. Lower catches more. |
| `--pre` / `--post` | 0.5 | Seconds kept before the gather / after release. |

Other useful options: `--dry-run` (list clips without exporting), `--fresh`
(redo pose detection), `--debug` (write per-frame signals to `signals.csv`).
Run `.venv/bin/python jumpshot_trimmer.py detect -h` for the full list.
