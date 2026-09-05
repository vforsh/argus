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

Recordings are silent MP4/H.264 files by default. WebM (VP9) and GIF are supported with `--format` or a matching `--out` extension. Default FPS is 30; use `--fps <1-60>` for large canvases or lighter artifacts.

```bash
argus record app --duration 5s --selector "canvas" --fps 12 --out canvas.mp4
argus record app --duration 5s --selector "canvas" --format webm --out canvas.webm
```

Use GIF when the clip has to render inline somewhere that will not play video — a GitHub comment, an issue, a chat message. GIF defaults to 12 fps and caps at 20, because GIF frame delays are whole centiseconds and anything faster only inflates the file.

```bash
argus record app --duration 4s --selector "canvas" --out bug.gif
```

Frames are captured as JPEG at quality 90 and re-encoded, which keeps large canvases cheap in the renderer. `--quality <1-100>` adjusts that intermediate quality; it is not the output bitrate. GIF captures lossless PNG frames instead, because palette quantization amplifies JPEG ringing on flat UI.

### Stopping on a condition

`--until` records until a page expression is truthy, for flows whose length you do not know up front. It is evaluated against the selected target every 250ms (`--poll` to change that), and bounded by `--max` (default 60s) so a condition that never fires cannot record forever.

```bash
argus record app --until "window.gameOver === true" --max 30s --out run.mp4
argus record app --until "document.querySelector('.result')" --max 10s --poll 100ms --out flow.gif
```

The response's `stopReason` says which bound ended the capture: `duration`, `until`, `max-duration`, `requested`, or `detached`.

### Manual interaction windows

```bash
argus record start app --selector "canvas" --out canvas.mp4
argus click app --selector "#play"
argus record stop app
```

`argus record status app` reports the active recording (elapsed time, frames, output path); the active recording also appears in `argus status`. An open-ended `record start` stops itself after `--max` (default 10 minutes) so a forgotten recording cannot hold an encoder until the watcher dies.

### Recording from a scenario

A bundled eval scenario records through `ctx.record`, which names the clip instead of choosing a path — the file lands under `scenarios/recordings/` in the watcher artifact directory, the same way `ctx.checkpoint` works.

```ts
export default async function scenario(ctx: ArgusScenarioContext) {
	await ctx.record.start('level-one', { selector: '#game', fps: 15 })
	document.querySelector('#play').click()
	await new Promise((resolve) => setTimeout(resolve, 3000))
	return await ctx.record.stop()
}
```

Scenario actions time out after 30s, so stop long recordings from the CLI rather than from inside the scenario.

## Crop Semantics

Viewport capture records or screenshots the visible page viewport. Selector capture resolves the element once at capture start, then crops page pixels to that element rectangle. Clip capture uses `x,y,width,height` in viewport CSS pixels.

If the selected element moves or resizes during a recording, Argus keeps the original crop rectangle for that recording. Prefer a stable canvas/container selector for games.

A recording can only contain what the page is showing, because it is built from Chrome's screencast of the visible viewport. `record --selector` therefore scrolls its target into view before measuring it, and a crop that still falls outside the viewport is rejected with an error rather than encoded as a sliver. `screenshot --selector` has no such limit for on-screen elements but also cannot capture below the fold — scroll first if the element is off-screen.

## Frame Rate and Duplicate Frames

Chrome emits a screencast frame only when the page repaints. Argus paces the encoder against the wall clock, so a file's duration always matches the capture window, but a static page yields a stream of identical frames and a page painting slower than `--fps` yields duplicates. That is inherent to screencast capture, not a bug — lower `--fps` for static or slow content and the file gets smaller with no visible loss.

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

Recording brings the page to the front before capturing. If it still fails with no frames, make the page visible and unthrottled:

```bash
argus page show app
argus record app --duration 3s --selector "canvas" --out canvas.mp4
```

If recording fails because `ffmpeg` is missing, install it or point Argus at it:

```bash
ARGUS_FFMPEG=/opt/homebrew/bin/ffmpeg argus record app --duration 3s --out demo.mp4
```

MP4 output requires an ffmpeg build with `libx264`, and WebM requires `libvpx-vp9`. If your ffmpeg lacks one, install a full build or switch `--format`.

If the page or the CDP session goes away mid-capture, the recording is still finalized and the response carries `partial: true` with `stopReason: "detached"`. The file holds everything captured up to that point rather than being lost or left unplayable.

A recording survives page navigation: Argus re-arms the screencast on each top-frame navigation and reports how many it crossed in `navigations`.
