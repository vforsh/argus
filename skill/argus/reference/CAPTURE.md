# Capture: Screenshot, Record, Trace

`--out` is absolute or relative to **your** cwd (`~` expands); the response's `outFile` is the absolute path. SDK/raw-HTTP callers must send absolute paths. Under `--policy background` capture returns `not_available` ([PAGE.md](./PAGE.md#visibility-lock)).

## Screenshot

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
argus screenshot app --testid "game-canvas" --out game.png
argus screenshot app --clip 100,80,640,360 --out crop.png      # viewport CSS px; exclusive with --selector
argus screenshot app                                           # watcher picks a path under its artifacts dir
```

Captures the visible viewport; off-screen elements need `scroll-to` first. With an iframe selected, the selector resolves inside the iframe and the crop is translated to page pixels.

## Record

Silent video from Chrome's screencast. MP4/H.264 default; WebM (VP9) and GIF via `--format` or the `--out` extension. Needs `ffmpeg` (`libx264` for MP4, `libvpx-vp9` for WebM); point at a binary with `ARGUS_FFMPEG=/path/ffmpeg`.

```bash
argus record app --duration 5s --out demo.mp4
argus record app --duration 3s --selector "canvas" --fps 12 --out canvas.mp4
argus record app --duration 3s --clip 100,80,640,360 --format webm --out crop.webm
argus record app --duration 4s --selector "canvas" --out bug.gif          # GIF: 12 fps default, cap 20
argus record app --until "window.gameOver === true" --max 30s --poll 100ms --out run.mp4
argus record start app --selector "canvas" --out canvas.mp4 --max 2m      # open-ended; default --max 10m
argus click app --selector "#play"
argus record status app                                                  # elapsed, frames, path; also in `watcher status`
argus record stop app --out final.mp4                                    # --record-id when several
```

- `--until <expr>` polls the selected target every `--poll` (250ms) and is bounded by `--max` (60s default). `stopReason` ∈ `duration | until | max-duration | requested | detached`.
- `--fps 1–60` (default 30); `--quality 1–100` is the intermediate JPEG quality, not bitrate. GIF captures PNG frames.
- Selector crop is resolved once at start and scrolled into view; a crop outside the viewport is rejected. Prefer a stable container selector for games.
- Static pages yield duplicate frames (screencast only emits on repaint) — lower `--fps` for smaller files.
- Recordings survive navigation (`navigations` count in the response). If the target detaches mid-capture the file is finalized with `partial: true`, `stopReason: "detached"`.
- From a scenario: `ctx.record.start(name, opts)` / `ctx.record.stop()` writes `scenarios/recordings/<name>.<fmt>` ([EVAL.md](./EVAL.md#typescript-scenarios)); stop long clips from the CLI (30s action timeout).

## Trace

```bash
argus trace app --duration 3s --out trace.json
argus trace start app --categories "devtools.timeline,v8.execute" --options "sampling-frequency=1000"
argus trace stop app --out trace.json       # --trace-id when several
```

Output is Chrome trace JSON; open in `chrome://tracing` or Perfetto.
