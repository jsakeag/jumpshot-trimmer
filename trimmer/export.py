"""Export: join clips into one video with ffmpeg."""

import json
import subprocess
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
    return f"Clip {c['n']}{' (maybe)' if c['maybe'] else ''} · {fmt_time(c['start'])} in original"


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


def export(video, clips, out, labels, progress=None):
    """Join the clips into one video, keeping the original's metadata. With labels, clip numbers
    are added as subtitles and chapters.

    progress(fraction) is called as it goes; without it ffmpeg prints its own stats.
    """
    _, has_audio, tags = probe(video)
    expr = "+".join(f"between(t,{c['start']},{c['end']})" for c in clips)
    filters = f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB,format=yuv420p[v]"
    maps = ["-map", "[v]"]
    if has_audio:
        filters += f";[0:a]aselect='{expr}',asetpts=N/SR/TB[a]"
        maps += ["-map", "[a]"]
    inputs, extra = ["-i", str(video)], []
    if labels:
        srt, chapters = out.with_suffix(".srt"), out.with_suffix(".chapters.txt")
        write_clip_labels(clips, srt, chapters)
        inputs += ["-i", str(chapters), "-i", str(srt)]
        maps += ["-map", "2:s", "-map_chapters", "1"]
        extra += ["-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-disposition:s:0", "default"]
    report = ["-progress", "pipe:1", "-nostats"] if progress else ["-stats"]
    partial = out.with_name(out.stem + ".partial" + out.suffix)
    cmd = ["ffmpeg", "-y", "-v", "error", *report, *inputs, "-filter_complex", filters, *maps,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
           *metadata_args(tags), *extra, "-movflags", "+faststart+use_metadata_tags", str(partial)]
    if progress:
        total = sum(c["end"] - c["start"] for c in clips)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in proc.stdout:
            key, _, val = line.strip().partition("=")
            if key == "out_time_us" and val.isdigit():
                progress(min(1.0, int(val) / 1e6 / total))
        if proc.wait():
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.read().strip()[-500:]}")
    else:
        subprocess.run(cmd, check=True)
    partial.replace(out)
