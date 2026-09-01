## Capture Commands

Use this when you need page pixels: screenshots for quick state checks, recordings for motion/gameplay/repro clips.

## Screenshots

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
argus screenshot app --clip 100,80,640,360 --out crop.png
argus screenshot app --testid "game-canvas" --out game.png
```

`--selector` and `--clip` are mutually exclusive. `--clip` is viewport-relative in CSS pixels. `--testid <id>` is shorthand for `--selector "[data-testid='<id>']"`.

## Output Paths

`--out` is absolute, or relative to the working directory of the process running the CLI — `--out build/shots/page.png` lands under your cwd, and `~` expands. This holds for `screenshot`, `record`, and `trace`; the response's `outFile` is always the absolute path that was written.

The watcher writes the file, and its own working directory is a temp artifacts dir, so callers that skip the CLI (the SDK, raw HTTP) must send an absolute path — a relative one resolves under that temp dir instead.

## Recording

```bash
argus record app --duration 5s --out demo.mp4
argus record app --duration 3s --selector "canvas" --out canvas.mp4
argus record app --duration 3s --clip 100,80,640,360 --out crop.mp4
argus record app --duration 3s --testid "game-canvas" --out game.mp4
```

Recordings are silent MP4/H.264 files by default. WebM is supported with `--format webm` or a `.webm` output path. Default FPS is 30; use `--fps <1-60>` for large canvases or lighter artifacts.

```bash
argus record app --duration 5s --selector "canvas" --fps 12 --out canvas.mp4
argus record app --duration 5s --selector "canvas" --format webm --out canvas.webm
```

For manual interaction windows:

```bash
argus record start app --selector "canvas" --out canvas.mp4
argus click app --selector "#play"
argus record stop app
```

## Crop Semantics

Viewport capture records or screenshots the visible page viewport. Selector capture resolves the element once at capture start, then crops page pixels to that element rectangle. Clip capture uses `x,y,width,height` in viewport CSS pixels.

If the selected element moves or resizes during a recording, Argus keeps the original crop rectangle for that recording. Prefer a stable canvas/container selector for games.

## Extension / Iframes

For iframe-active extension watchers, capture commands resolve selectors inside the selected iframe, then capture top-level page pixels with the translated crop. This is the same target model used by `eval`, DOM commands, and screenshots.

```bash
argus ext use --url portal.example --as app --iframe-url game-frame-host.example
argus record app --duration 5s --selector "canvas" --out game.mp4
```

If capture runs against the host page instead of the app, select the iframe first:

```bash
argus ext targets app --tree
argus ext select app --iframe-url game-frame-host.example
```

## Troubleshooting

If recording fails with no frames, make the page visible and unthrottled:

```bash
argus page show app
argus record app --duration 3s --selector "canvas" --out canvas.mp4
```

If recording fails because `ffmpeg` is missing, install it or point Argus at it:

```bash
ARGUS_FFMPEG=/opt/homebrew/bin/ffmpeg argus record app --duration 3s --out demo.mp4
```

MP4 output requires an ffmpeg build with `libx264`. If your ffmpeg lacks it, install a full build or record WebM with `--format webm`.
