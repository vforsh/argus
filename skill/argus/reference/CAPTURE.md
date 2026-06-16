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

## Recording

```bash
argus record app --duration 5s --out demo.webm
argus record app --duration 3s --selector "canvas" --out canvas.webm
argus record app --duration 3s --clip 100,80,640,360 --out crop.webm
argus record app --duration 3s --testid "game-canvas" --out game.webm
```

Recordings are silent WebM files. Default FPS is 30; use `--fps <1-60>` for large canvases or lighter artifacts.

```bash
argus record app --duration 5s --selector "canvas" --fps 12 --out canvas.webm
```

For manual interaction windows:

```bash
argus record start app --selector "canvas" --out canvas.webm
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
argus record app --duration 5s --selector "canvas" --out game.webm
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
argus record app --duration 3s --selector "canvas" --out canvas.webm
```

If recording fails because `ffmpeg` is missing, install it or point Argus at it:

```bash
ARGUS_FFMPEG=/opt/homebrew/bin/ffmpeg argus record app --duration 3s --out demo.webm
```

Recording is WebM-only for now. Use external tooling for GIF/MP4 conversion after capture.
