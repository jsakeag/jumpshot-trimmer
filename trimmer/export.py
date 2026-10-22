"""Export: join clips into one video with ffmpeg."""

import json
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime, timezone

# Original metadata worth carrying over: capture date, location, device.
KEEP_TAGS = ("com.apple.quicktime.creationdate", "com.apple.quicktime.location.ISO6709",
             "com.apple.quicktime.location.accuracy.horizontal", "com.apple.quicktime.make",
             "com.apple.quicktime.model", "com.apple.quicktime.software")


def probe(video):
    """(duration, has_audio, format tags) of a video."""
    info = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags:stream=codec_type",
         "-of", "json", str(video)], capture_output=True, text=True, check=True).stdout)
    has_audio = any(st["codec_type"] == "audio" for st in info["streams"])
    return float(info["format"]["duration"]), has_audio, info["format"].get("tags", {})


def fmt_time(sec, ms=False):
    m, s = divmod(sec, 60)
    if ms:
        h, m = divmod(int(m), 60)
        return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")
    return f"{int(m)}:{int(s):02d}"


def timeline(clips):
    """Where each clip lands in the combined video."""
    out, reel = [], 0.0
    for c in clips:
        d = c["end"] - c["start"]
        out.append({**c, "reel_start": round(reel, 3), "reel_end": round(reel + d, 3)})
        reel += d
    return out


def label(c):
    return f"{c.get('label', 'Clip')} {c['n']}{' (maybe)' if c['maybe'] else ''} · {fmt_time(c['start'])} in original"


def write_clip_labels(clips, srt_path, chapters_path):
    """Subtitle + chapter files that label each clip in the combined video."""
    srt, chap = [], [";FFMETADATA1"]
    for i, c in enumerate(clips, 1):
        srt += [str(i), f"{fmt_time(c['reel_start'], True)} --> {fmt_time(c['reel_end'], True)}", label(c), ""]
        chap += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(c['reel_start'] * 1000)}",
                 f"END={int(c['reel_end'] * 1000)}", f"title={label(c)}"]
    srt_path.write_text("\n".join(srt))
    chapters_path.write_text("\n".join(chap) + "\n")


def metadata_args(tags):
    """ffmpeg args that copy the original's capture date, location and device.

    Photos sorts by creation_time, which a converted copy of a video (e.g. one iOS re-encoded)
    can have reset to the conversion time. The camera's own creationdate survives, so
    creation_time is rebuilt from it.
    """
    md = {k: tags[k] for k in KEEP_TAGS if k in tags}
    if "com.apple.quicktime.creationdate" in tags:
        when = datetime.fromisoformat(tags["com.apple.quicktime.creationdate"])
        md["creation_time"] = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    elif "creation_time" in tags:
        md["creation_time"] = tags["creation_time"]
    args = ["-map_metadata", "-1"]
    for k, v in md.items():
        args += ["-metadata", f"{k}={v}"]
    return args


def frame_rate(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                          "-of", "default=nw=1:nk=1", str(video)], capture_output=True, text=True, check=True).stdout.strip()
    return out or "30"


def _run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()[-500:]}")


def export(video, clips, out, labels, progress=None):
    """Join the clips into one video, keeping the original's metadata. With labels, clip numbers
    are added as subtitles and chapters.

    Each clip is cut on its own (seeking straight to it, so only the clips are decoded), then the
    pieces are joined without re-encoding. progress(fraction) is called after each clip.
    """
    _, has_audio, tags = probe(video)
    rate = frame_rate(video)
    partial = out.with_name(out.stem + ".partial" + out.suffix)
    with tempfile.TemporaryDirectory(dir=out.parent, prefix=".export-") as tmp:
        tmp = Path(tmp)
        parts = []
        for i, c in enumerate(clips):
            part = tmp / f"{i:05d}.mp4"
            # identical encoding settings for every piece, so they can be joined losslessly
            _run(["ffmpeg", "-v", "error", "-y", "-ss", str(c["start"]), "-i", str(video), "-t", str(c["end"] - c["start"]),
                  "-map", "0:v:0", *(["-map", "0:a:0"] if has_audio else []),
                  "-vf", "format=yuv420p", "-fps_mode", "cfr", "-r", rate,
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(part)])
            parts.append(part)
            if progress:
                progress((i + 1) / len(clips) * 0.97)
        listing = tmp / "parts.txt"
        listing.write_text("".join(f"file '{p.name}'\n" for p in parts))
        inputs, maps, extra = ["-f", "concat", "-safe", "0", "-i", str(listing)], ["-map", "0:v", *(["-map", "0:a"] if has_audio else [])], []
        if labels:
            srt, chapters = out.with_suffix(".srt"), out.with_suffix(".chapters.txt")
            write_clip_labels(clips, srt, chapters)
            inputs += ["-i", str(chapters), "-i", str(srt)]
            maps += ["-map", "2:s", "-map_chapters", "1"]
            extra += ["-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-disposition:s:0", "default"]
        meta = metadata_args(tags)
        if labels:  # take metadata from the chapters file (only chapter titles) instead of clearing it
            meta[meta.index("-map_metadata") + 1] = "1"
        _run(["ffmpeg", "-v", "error", "-y", *inputs, *maps, "-c:v", "copy", "-c:a", "copy", *extra,
              *meta, "-movflags", "+faststart+use_metadata_tags", str(partial)])
    partial.replace(out)
    if progress:
        progress(1.0)
