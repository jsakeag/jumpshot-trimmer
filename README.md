# Mock Premiere Lite

A small web video editor for reviewing practice sessions, mainly tennis. You mark strokes
while the video plays, tag each one with habits you want to track (for example "one-footed hop"
or "closed weight shift") and score how strongly each tag shows, then filter and rank them.
Export joins the confirmed strokes into one video.

It's a lite take on the sister repo `mock-premiere-pro`: a preview window, a timeline and an
annotations panel, running in your browser on your Mac.

## Setup (once)

Requires macOS with [Homebrew](https://brew.sh) and Python 3.11+.

```sh
brew install ffmpeg
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```sh
.venv/bin/python server.py
```

Open http://localhost:8000. Put session videos in `data/` (**Open data folder** on the home page)
and they show up in the list. A video is only read when you open it.

## The editor

- **Preview** (center): plays the video, with a scrub bar showing your annotations. The transport
  has play/pause, frame steps, previous/next annotation, speed, loop, volume and full screen.
- **Timeline** (bottom): a time ruler, a filmstrip, the audio's loudness (handy for spotting
  hits) and your annotations. Click or drag on the top tracks to scrub. Drag an annotation to move
  it, or drag its ends to trim it; ends snap to the playhead. Zoom with the slider, `=` / `-`, or
  ⌘-scroll / pinch.
- **Inspector** (left): the selected annotation's kind, in and out times, whether it's
  confirmed, and its tags with a 1–5 score each.
- **Annotations panel** (right, `\` to open or close): every annotation, split into
  **Confirmed** and **Maybe**, with their tags. Filter by kind and by tags (any or all), set a
  minimum strength, and sort by time or by strength (the highest score among the selected tags,
  or among all tags if none is selected). **Play only these** (`R`) plays just the listed
  annotations and skips everything between them, e.g. pick FH under Kind to watch only forehands.

### Marking strokes

Hold a key while the video plays, from the start of the stroke to the end:

| Key | Marks |
|---|---|
| `F` | Forehand |
| `B` | Backhand |
| `;` | Serve |
| `⇧F` / `⇧B` | Forehand / backhand, tagged `volley` |

A quick tap (or a press while paused) marks 1.5 s around the playhead. While paused, you can
hold the key and step with the arrow keys to mark precisely.

Started too late? Press `Z`: it takes back the last mark and rewinds to 1 s before its key went
down, so you can mark it again. Press it again to take back the one before.

Annotations you mark are confirmed. To tag one, select it and press `T`: type to search the labels, ↑↓ and Enter to pick (or Enter on
**+ Create** for a new one), then type its score (1–5). In the picker, ✎ renames a label and ×
deletes it, everywhere it's used in every video; click its dot to change its color. Labels are
shared by all your videos.

### Footwork

Footwork marked on the video belongs to a forehand or backhand, and can only be marked on one:
the one the playhead is in (or the selected one). Press `D` and click to place steps (numbered in
order); ⇧-click places one that lands together with the previous step, like a hop, so both get
the same number. ⌥-click, with or without the tool, where your feet were at the split step (two feet; a
third click replaces the oldest). They show on the video whenever that stroke plays. Each stroke's steps also
list in the inspector as a numbered sequence (split-step feet first), where you name each one with the same
kind of picker, e.g. "drop step". Step names and split-step foot names are each their own shared list, separate from labels. Mark a
step name bad with ⚠ in the picker (e.g. "balance step", one that ideally isn't needed): those
steps show in red, the panel counts them on each stroke, and **⚠ Bad steps** filters to strokes
that have any. Click a step to
select it (a new one is selected too) and press ⌫ to delete it, again for the one before; or
right-click one to remove it; `Esc` puts the tool down. They aren't burned into the export.

### Ball flight in 3D (experimental)

Mark where the ball went, separately from the strokes, and see it in 3D on the **3D β** tab.

1. Press `G` (or **◎ Ball β**). The first time, place four or more known points on the court:
   pick one on the small court map (near end at the bottom; left and right as seen from the
   camera), then click where it is on the video. Points spread out (not all on one line) work
   best. Once the drawn court lines sit on the real ones, press **Done** (↵). This finds where
   the camera is and its lens.
2. Step frame by frame and click the ball. `⇧`-click where it bounces, `⌥`-click where the
   racket hits it. Each flight between a hit and a bounce needs at least 3 clicks (e.g. the
   hit, one mid-flight, the bounce); more is better. `N` starts a new track, `[` `]` move
   between tracks, `⌫` or right-click removes a point, `⌘Z` undoes.
3. The fitted flight (gravity and air drag) is drawn back on the video, so you can see whether
   it follows the ball. The **3D β** tab shows every track on the court with its speed off the
   racket, peak height and net clearance; drag to turn it, or pick **Camera** to see it from
   where you filmed.

It's one camera, so depth comes from gravity and the bounces: expect speeds within about 5–10%.
Spin isn't modeled, so heavy topspin reads a little fast and low. For slow-motion video, set
**Slow-mo** to how many times slower it plays.

### All keys

| Key | Does |
|---|---|
| Space / `K` | Play / pause |
| ← → | Step a frame (⇧: 1 s) |
| `J` / `L` | 5 s back / ahead (with Play only these on, the arrow keys and J/L skip the gaps between listed annotations) |
| ↑ ↓ | Previous / next annotation in the panel |
| Enter | Confirm, or back to maybe |
| `I` / `O` | Set the selected annotation's in / out to the playhead |
| `T` | Add a tag |
| `P` | Play the selected annotation |
| ⌫ | Delete it (or the newest mark); press again to delete the mark before |
| `D` | Step tool; ⌥-click marks split-step feet |
| `G` | Ball tool (experimental) |
| `R` | Play only the listed annotations, on/off |
| `M` | Mute |
| ⌘Z / ⇧⌘Z | Undo / redo |
| `?` | Show all keys |

Everything saves on its own a moment after you change it.

## Plugins

**Plugins…** runs a detector that annotates for you. What it finds comes in as **maybe** for you
to confirm (✓ in the panel, or Enter); ones the detector wasn't sure about are also marked
**weak**. Running a plugin again replaces its maybes that you haven't tagged. Plugins only
annotate; they never export.

- **Tennis serves**: serves from either player, by pose (both arms up after standing still),
  from the toss to the follow-through. Drag a box around the far baseline on the current frame
  (with about two player-heights of room above for the toss) so the far player can be seen up
  close; it's remembered for the next video. Takes about 0.8x the video's length the first time;
  the pose is cached after that. A serve with no contact sound right after it is weak. Tuned on
  one session filmed from the corner, so a different angle or light may need the thresholds in
  `trimmer/serves.py` adjusted.
- **Tennis points**: points from the sound of the ball, a run of racket hits less than 8 s
  apart. Takes seconds. Tightness (loose, medium, tight) trades how much is kept against how
  much of each point survives.
- **Basketball shots**: jumpshots and layups by pose, from the gather to just after release.
  Thresholds are in `DetectParams` in `trimmer/detect.py`.

A plugin is an entry in `trimmer/plugins.py`: a function that takes the video and returns
`[{start, end, weak}]`, plus the kind of annotation it makes.

## Export

**Export** in the top bar joins every confirmed annotation (maybes are left out; overlapping ones
are joined) into `out/<name>/<name>_final.mp4`. It keeps the original's capture date and
location. Then use **Show in Finder** or **Download**.

## Command line

```sh
.venv/bin/python cli.py detect IMG_0121.MOV points --tightness medium
.venv/bin/python cli.py detect IMG_0121.MOV serves --far-box 0.47,0.42,1,0.79
.venv/bin/python cli.py list IMG_0121      # annotations and their tags
.venv/bin/python cli.py review IMG_0121    # every annotation, labeled with subtitles and chapters
.venv/bin/python cli.py export IMG_0121    # the confirmed annotations, clean
```

The web app and the command line share the same project files, so you can mix them.

## Files

Everything for a video goes in `out/<video name>/`:

| File | What it is |
| --- | --- |
| `project.json` | The annotations, their tags and scores, and plugin settings |
| `<name>_final.mp4` | The exported video |
| `<name>_review.mp4` | Every annotation, labeled (command line only) |
| `filmstrip.jpg`, `wave.bin`, `media.json` | What the timeline draws |
| `pose.npz`, `serve_pose.npz` | Cached pose data from plugins |
| `ball.json` | Court points and ball tracks (experimental) |

**Clear all videos** on the home page moves everything in `data/` and `out/` to the Trash.

## Project layout

| Path | What it is |
| --- | --- |
| `trimmer/` | The core: annotations and exports (`project.py`), plugins (`plugins.py`) and their detectors (`serves.py`, `tennis.py`, `detect.py` with `pose.py`), timeline media (`media.py`), ffmpeg export (`export.py`) |
| `server.py`, `web/` | The web app: API server and the editor page (`editor.js`, `timeline.js`; the ball tool in `ball.js`, its geometry and physics in `ballgeo.js`) |
| `cli.py` | The command line |
