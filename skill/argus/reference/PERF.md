# Perf: Gesture Smoothness

Measure, compare and gate how smooth a pan/drag feels, with no human in the loop. A human gesture stays optional: record it once, replay it.

```bash
argus perf gesture app --press-key h --path line:-600,0 --speed 900 --rate 250 --repeat 5 --warmup 1 --motion --out runs/a.json
argus perf gesture app --hold-key Space --path circle:300 --duration 3s --out runs/b.json
argus perf compare runs/a.json runs/b.json            # per-metric deltas, noise-aware verdict
argus perf compare runs/a.json runs/b.json --thresholds gate.json --fail-on-worse   # CI gate: exit 1 on regression, invalid run or missing metrics
```

| Command | Does |
| --- | --- |
| `trace --preset frames\|input\|gpu` | Trace with the category set the analyzers need (`--categories` appends) |
| `trace analyze <file> [frames\|input]` | Stream a raw trace: presentation states, stages, main frame; EventLatency |
| `perf gesture` | Unattended mouse gesture + trace (+ motion) → run result. The gate |
| `perf capture` | Arm a passive recorder, block until a human gesture is done |
| `perf motion` | On-screen displacement per presented frame |
| `input record` / `input replay` | Record real input once (JSONL), replay with original timing |
| `perf compare <a> <b>` | Compare two run results or raw traces |

## Run result

`perf gesture`, `perf capture`, `perf motion` and `trace analyze --out` write one schema (`schema: "argus.perf.run"`, `version: 1`). Sections, each present only when measured:

- `presentation`: `PipelineReporter` state counts, `frameTypes` (`FORKED`, `BACKFILL`), `partialShare` = PARTIAL / (ALL + PARTIAL), `droppedShare`, average stage ms per state, presented-frame interval.
- `latency`: `EventLatency` per `event_type` (count, p50/p95, direct stages, `attributedShare`), `mouse` summary, `flags`.
- `mainFrame`: `ProxyMain::BeginMainFrame` p50/p90/p99 on `CrRendererMain`, average breakdown (input handling, animate/rAF, style, layout, paint, commit).
- `motion`: per-frame steps (CSS px), `zeroStepFrames`, `doubleSteps`, `stepCv`, `longestStallMs`, `presentedFps`, sparkline.
- `raf`: frames, FPS, interval distribution, intervals over 20 ms.
- `input`: DOM events by type, interval, gaps over 25 ms, **events per frame (0/1/2+)**, raw samples per frame (0…5+), raw sample rate.
- `longFrames`: LoAF entries (script vs render ms) and long tasks.
- `probe`: steps of `--probe <expr>` per rAF, frames with input but no motion, zero runs, double steps.
- `playback`: watcher input-player stats (dispatched, achieved rate, lateness, ack time).
- `validity`, `meta`, `summary` (flat headline metrics; with `--repeat` the median plus `min`/`max`), `runs` (per repeat), `samples` (`perf capture --out`: raw rAF, input, probe).

Exit code 1 means the run is invalid; the file is still written so the reason is visible.

## Traps the analyzers handle

- Async ids (`id2.local`) are reused, so spans pair with a stack per (pid, tid, id, name) and children nest by time containment.
- rAF/WebGL apps rarely attribute presentation to an input event. Their `EventLatency` stops at main-thread handling (≈16 ms vs ≈55 ms), so it is **not comparable** with an app that updates the DOM in its handler. The report flags it, and the summary renames the metric `latency.mouseUnattributedP50Ms`, so `perf compare` never calls it faster.
- Renderer: the process holding the recorder's `argus-perf-start` mark, else the one with the most `BeginMainFrame` events; `--pid` overrides.
- Analyzers stream the file. A 50 MB trace takes about 0.15 s and holds one event at a time in memory. Motion keeps only the screenshots inside the recording window and decodes them at about 10 ms per frame.
- The recorder drops `performance.mark('argus-perf-start:<token>'|'argus-perf-end:<token>')`. Analysis is cut to that recorder's window, and its start mark aligns the page clock with the trace clock. The per-recorder token keeps concurrent recorders from mixing.

## perf gesture

- **Start**: `--at x,y`, or the centre of `--selector` / `--clip` / the viewport.
- **Mode keys**: `--press-key h` (tool hotkey before the drag), `--hold-key Space` (held during it), `--button left|middle|right`.
- **Path**: `--path line:dx,dy | circle:r | figure8:r | file:path.json` (array of `[x,y]` or `{x,y,t?}` offsets from the start; with `t` on every point, times are used as-is). Speed comes from `--speed px/s` (default 900) or `--duration`.
- **Rate**: `--rate 60–1000` Hz (default 250). The watcher's input player (`POST /input/play`) dispatches on a high-resolution clock with at most `--max-in-flight` (8) outstanding acks. It never awaits each one: awaiting caps delivery near 30 Hz, two frames per ack. `--jitter <ms>` adds deterministic gaps (the same on every repeat).
- **Replay**: `--replay pan.jsonl` plays a recording (with `--cadence`, `--offset`, `--scale`; `--button` rewrites the button).
- **Repeats**: `--warmup N` unmeasured gestures, then `--repeat N` measured runs. The summary is the median with `[min–max]`. Sections come from the median run.
- `--motion` adds per-frame screenshots, `--probe` samples an app value, `--preset` picks the trace categories, `--no-trace` keeps only input delivery and rAF, and `--keep-trace` keeps the raw trace (`.runN` suffix with repeats).

## perf capture / perf motion

```bash
argus perf capture app --duration 7s --probe "window.app.camera.y" --trace frames --motion --out cap.json
argus perf motion app --arm-on input --duration 5s --clip 0,40,1200,800 --json
argus perf motion app --arm-on now --duration 3s          # animations: no input needed
```

- `--arm-on input` (default) starts on the first trigger: a `pointermove` with a button held, a `wheel` or a `touchmove`. `--triggers` changes the set (`pointermove,wheel,touchmove,pointerdown,hover,keydown`). The command **blocks until the capture ends**. `--timeout` (default 60 s) fails it when nobody moves.
- An in-page badge says "move now", then "Recording… N s", then "Done". `--no-badge` hides it. The badge updates once a second so it barely adds frames.
- Afterwards the recorder removes every listener, observer, timer, mark and the badge. Concurrent recorders (`input record` while `perf gesture` drives) do not interfere.
- Motion: phase correlation (FFT cross-power spectrum) between consecutive presented frames, with band-limited sub-pixel refinement, over the `--clip` region. A constant 8 px/frame pan reads 8.1 px with 0 zero-step frames. Skipping every third update shows a zero step every third frame, and a 2× step after it when the app catches up. Zero steps count from the first moving frame to the end of input: latency before the first update is not judder, but a freeze while the drag continues is (zero steps plus a trailing stall).

## Recording format (`input record`)

JSON Lines. The first line is a header, and every other line is one event; `t` is ms from the recording start.

```json
{"format":"argus-input","version":1,"recordedAt":"…","url":"…","viewport":{"width":1200,"height":800,"devicePixelRatio":2},"durationMs":7000,"events":1432}
{"t":-22.2,"type":"pointerdown","x":600,"y":642,"button":0,"buttons":1,"modifiers":0,"pointerType":"mouse","pointerId":1}
{"t":0.4,"type":"pointermove","x":598,"y":642,"button":-1,"buttons":1,"modifiers":0,"pointerType":"mouse","pointerId":1,"coalesced":4}
{"t":0.4,"type":"pointermove","x":598,"y":642,"button":-1,"buttons":1,"modifiers":0,"pointerType":"mouse","pointerId":1,"raw":true}
{"t":2000.1,"type":"wheel","x":600,"y":400,"deltaX":0,"deltaY":120,"deltaMode":0,"buttons":0,"modifiers":0}
{"t":2100.0,"type":"keydown","key":" ","code":"Space","modifiers":0}
```

- `modifiers` is a bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. `buttons` is the DOM mask: left 1, right 2, middle 4.
- A pointer move is stored twice: the dispatched DOM event (`coalesced: n`) and each raw `getCoalescedEvents()` sample (`raw: true`). Replay sends the raw samples, so the device rate survives. Analysis uses the DOM events to see what the page actually received.
- A press held before the first move is kept, with a negative `t`.
- Replay maps mouse pointers to `Input.dispatchMouseEvent`, touch pointers to `Input.dispatchTouchEvent`, wheel deltas to CSS px (lines ×40) and keys by `code`. Mouse drag is the reference path; wheel and touch are supported, keys replay except modifiers (those travel in `modifiers`).
- `--cadence frame` snaps every event up to the next boundary of a fixed 60 Hz grid that starts at playback. It strips sub-frame timing for comparison, but it is not phase-locked to the page's rAF or to a 120/144 Hz display.

## Validity guards

A run is marked invalid with a reason and never reported silently. Distorted sections are dropped from `summary`, and `perf compare` labels invalid runs "not comparable".

| Code | When |
| --- | --- |
| `headless` | Headless Chrome (UA, `/json/version`, or a local `--headless` launch flag). `--allow-headless` turns it into a warning and keeps only input, main-frame and long-frame metrics |
| `page_hidden` | The page was hidden (background tab, minimized or occluded window) |
| `raf_throttled` | rAF under 20 FPS, or no rAF frames at all, on a visible page (an occluded window on macOS) |
| `software_gl` | SwiftShader, llvmpipe or another software renderer |
| `trace_data_loss` | Chrome reported trace buffer overflow |
| `no_motion` | The gesture moved nothing on screen (motion or probe), or no screenshots arrived |
| `motion_unmeasurable` | Over 25% of frames had no trustworthy displacement (flat or changing content in the clip). Those frames are never counted as zero steps |
| `too_short` | The recording was under 100 ms |
| `no_input` | The page saw no input (wrong coordinates, an overlay, or another tab) |
| `high_load`, `other_chrome` | Warnings: 1-minute load above 0.8 per CPU, or more than one Chrome instance running |

## Compare and thresholds

`perf compare` accepts run results or raw traces (analyzed on the fly). Each metric carries a direction (`better: lower|higher`). The noise floor is the wider of half the min–max spread across repeats and the thresholds entry. Without a thresholds entry, a per-unit default applies: 1 ms, 0.02 ratio, 1 count, 1 FPS, 5 Hz, or 5% of the value. Calibrate thresholds once against human judgement:

```json
{ "default": { "rel": 0.05 }, "metrics": { "presentation.partialShare": { "abs": 0.03 }, "motion.zeroStepFrames": { "abs": 2 } } }
```

## Modes and overhead

- **CDP watchers**: everything works. **Extension mode**: everything works too. Tracing goes through `chrome.debugger` on the tab, so the trace holds that tab's renderer plus Browser/GPU, which is all the analyzers need.
- The screenshot category (`--motion`) makes the browser JPEG-encode a downscaled (~500 px) copy of every presented frame. Compare runs taken with the same flags.
- The recorder adds passive listeners, one rAF callback (plus the probe) and two PerformanceObservers.
- Tracing and analysis run where the watcher writes the trace file. The CLI reads that file, so it must run on the watcher's machine.

## Unattended headed runs (second machine)

Headless distorts presentation, and only a visible window with trusted input gives comparable numbers. Keep the gate off the developer's screen with a dedicated Mac or Linux box driven over SSH:

```bash
# On the bench machine (once): no sleep, no screen saver
sudo pmset -a sleep 0 displaysleep 0 disksleep 0           # macOS; on Linux: systemd-inhibit or xset s off -dpms
# Each session, over SSH
ssh bench 'caffeinate -dimsu &'                              # macOS: keep display awake while the gate runs
ssh bench 'argus chrome start --profile temp --url http://app.local:3000 --json &'   # headed, inside the logged-in GUI session
ssh bench 'osascript -e "tell application \"Google Chrome\" to set bounds of front window to {0, 0, 1440, 900}"'
ssh bench 'argus watcher start --id app --url app.local:3000 &'
ssh bench 'argus perf gesture app --press-key h --path line:-600,0 --repeat 5 --warmup 1 --motion --out runs/$(git rev-parse --short HEAD).json'
```

- Keep the window at a fixed size and position and in front. On macOS an occluded window stops rAF, and the guards report `page_hidden`/`raf_throttled` instead of numbers. Nothing else should cover it.
- Linux: run Chrome on a real or virtual display (`Xvfb :1 -screen 0 1440x900x24`, `DISPLAY=:1`) with GPU access. Xvfb renders in software, so expect `software_gl` unless the box has a GPU-backed X server.
- Check `validity` in every result before trusting a verdict; `perf compare` already refuses invalid runs.
