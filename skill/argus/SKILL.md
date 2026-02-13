---
name: argus
description: Guides use of the Argus CLI to debug and inspect web apps via Chrome CDP or the Argus Chrome extension (start Chrome/watcher, select targets including iframes, tail logs, eval JavaScript, and capture screenshots).
---

## Argus CLI

Debug local web apps via Chrome CDP or extension. Logs, eval, screenshots, target management.

---

## Workflow

Launch Chrome with CDP enabled, auto-select targets via `--url` matching.

**CRITICAL for agents:** `argus start`, `argus watcher start`, and `argus chrome start` are **long-running processes that never exit on their own**. You **MUST** start them in the background (e.g., `run_in_background: true` in Bash tool). If you run them in the foreground, they will block indefinitely and you will not be able to execute any further commands.

```bash
# 1) Start app
npm run dev && export APP_URL="http://localhost:3000"

# 2) Launch Chrome + watcher in one command
argus start --id app --url localhost:3000  # Run with run_in_background: true

# 3) Use CLI (these are quick commands, run normally)
argus logs app --since 10m --levels error,warning
argus eval app "location.href"
argus screenshot app --out shot.png
argus snapshot app --interactive
```

Alternatively, launch Chrome and watcher separately for more control:

```bash
argus chrome start --url "$APP_URL"  # run_in_background: true
argus watcher start --id app --url "$APP_URL" --chrome-port 9222  # run_in_background: true
```

---

## Commands Cheat Sheet

### Start (Chrome + Watcher)

**Long-running process — must use `run_in_background: true`.** Convenience command that launches Chrome and attaches a watcher in one step.

```bash
argus start --id app --url localhost:3000
argus start --id app --url localhost:3000 --dev-tools
argus start --id app --url localhost:3000 --profile temp
argus start --id app --type page --headless
argus start --id app --url localhost:3000 --inject ./debug.js
argus start --id app --url localhost:3000 --no-page-indicator
argus start --id app --url localhost:3000 --json
```

`--url` opens in Chrome and matches the watcher target. Accepts all chrome options (`--profile`, `--dev-tools`, `--headless`) and watcher options (`--type`, `--origin`, `--target`, `--parent`, `--inject`, `--artifacts`, `--no-page-indicator`). CDP port is wired automatically.

### Chrome Start

**Long-running process — must use `run_in_background: true`.** Use when you need Chrome without a watcher, or need separate control.

```bash
argus chrome start --url http://localhost:3000
argus chrome start --from-watcher app
argus chrome start --dev-tools
argus chrome start --headless
```

`--from-watcher` reads URL from a registered watcher's config. `--headless` runs without a visible window.

### Watcher Start

**Long-running process — must use `run_in_background: true`.** Use when Chrome is already running with CDP enabled.

```bash
argus watcher start --id app --url localhost:3000
argus watcher start --id app --url localhost:3000 --chrome-port 9222
argus watcher start --id app --type iframe --url localhost:3007
argus watcher start --id app --type iframe --parent yandex.ru
argus watcher start --id app --origin https://localhost:3007
argus watcher start --id app --target CC1135709D9AC3B9CC0446F8B58CC344
argus watcher start --id app --url localhost:3000 --inject ./debug.js
argus watcher start --id app --url localhost:3000 --no-page-indicator
argus watcher start --id app --source extension
```

`--url` matches target URL substring. `--origin` matches protocol+host+port only. `--target` connects to a specific Chrome target ID. `--type` filters by target type (page, iframe, worker). `--parent` filters by parent target URL. `--inject` runs a JS file on attach + navigation. `--no-page-indicator` hides the in-page overlay — use this when capturing screenshots so the indicator badge doesn't appear in the image.

### Logs

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Error|Exception" --ignore-case
argus logs app --source console
argus logs app --json          # bounded JSON preview
argus logs app --json-full     # full JSON (can be large)
argus logs tail app            # stream via long-polling (use run_in_background)
argus logs tail app --levels error --json
```

### Eval

```bash
argus eval app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "document.title" --json
argus eval app --file ./script.js
```

### Eval-Until

Poll until expression returns truthy.

```bash
argus eval-until app "document.querySelector('#loaded')"
argus eval-until app "window.APP_READY" --interval 500
argus eval-until app "document.title === 'Ready'" --total-timeout 30s
argus eval-until app "window.data" --verbose --count 20
```

Exit codes: 0 = truthy found, 1 = error/exhausted, 2 = invalid args, 130 = SIGINT.

Full eval docs (polling, flags, iframe, eval-until): [EVAL.md](./reference/EVAL.md)

### Screenshots

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
```

### Network

```bash
argus net app --since 5m
argus net app --grep api
argus net app --json
argus net tail app
argus net tail app --grep api --json
```

### Storage

```bash
argus storage local get app theme
argus storage local set app theme dark
argus storage local remove app theme
argus storage local ls app
argus storage local clear app
```

### Trace

```bash
argus trace app --duration 3s --out trace.json
argus trace start app --categories "devtools.timeline"
argus trace stop app --out trace.json
```

### DOM (query)

```bash
argus dom tree app --selector "body"
argus dom tree app --testid "main-content"
argus dom tree app --selector "div" --all --depth 3
argus dom info app --selector "#root"
argus dom info app --selector "div" --all --json
argus snapshot app
argus snapshot app --interactive
argus snapshot app --selector "form" --depth 3
argus snapshot app --testid "login-form"
```

`--testid <id>` is shorthand for `--selector "[data-testid='<id>']"` and works on all commands that accept `--selector`. Cannot be combined with `--selector`.

`dom tree` returns a DOM subtree; control depth with `--depth` (default 2), cap nodes with `--max-nodes`. `dom info` returns detailed element info (attributes, outerHTML, box model). `snapshot` (aliases: `snap`, `ax`) captures an accessibility tree; `--interactive` / `-i` filters to buttons, links, inputs, etc.

### Interact (top-level)

```bash
argus click app --selector "button.submit"
argus click app --testid "submit-btn"
argus click app --selector ".delayed-btn" --wait 5s
argus click app --pos 100,200
argus hover app --selector ".menu-item"
argus hover app --selector ".item" --all
argus fill app --selector "#username" "Bob"
argus fill app --testid "username" "Bob"
argus fill app --selector "textarea" "New content"
argus fill app --selector "input[type=text]" --all "reset"
argus fill app --selector "#desc" --value-file ./description.txt
echo "hello" | argus fill app --selector "#input" --value-stdin
argus fill app --selector "#input" - < value.txt
argus fill app --selector ".dynamic-input" "text" --wait 3s
argus keydown app --key Enter
argus keydown app --key a --selector "#input"
argus keydown app --key a --modifiers shift,ctrl
```

`click` clicks at coordinates (`--pos x,y`) or on elements matching `--selector`/`--testid`. `hover` dispatches mouseover/mouseenter on matched elements. `fill` sets value on input/textarea/contenteditable; triggers framework-compatible events (focus → input → change → blur). Value can come from inline arg, `--value-file <path>`, or `--value-stdin` (also `-` as value arg). `keydown` dispatches keyboard events; use `--selector` to focus an element first, `--modifiers` for combos.

`--wait <duration>` (on click, fill) polls for the selector to appear before executing the action — useful for reactive UIs where elements render after navigation/SPA transitions. Duration format: `5s`, `500ms`, `2m`. `--text` filters by textContent, `--all` allows multiple matches.

### DOM (interact)

```bash
argus dom focus app --selector "#input"
argus dom focus app --testid "search-box"
argus dom set-file app --selector "input[type=file]" --file ./build.zip
argus dom set-file app --selector "input[type=file]" --file ~/Downloads/test.zip
argus dom set-file app --selector "#upload" --file a.png --wait 5s
```

`dom focus` programmatically focuses an element via CDP (`DOM.focus`); useful before typing or keyboard interactions. `dom set-file` sets files on `<input type="file">` elements; `--wait` polls for selector. Path flags (`--file`, `--value-file`, `--html-file`, `--artifacts`, inject paths) all support `~/` expansion.

### DOM (scroll — emulate gesture)

```bash
argus dom scroll app --by 0,300
argus dom scroll app --selector ".panel" --by 0,200
argus dom scroll app --testid "feed" --by 0,500
argus dom scroll app --pos 400,300 --by 0,200
```

Emulates touch scroll gestures via CDP `Input.emulateTouchScrollGesture` — fires real wheel/scroll events. `--by dx,dy` is required (positive y = scroll down). Without `--selector` or `--pos`, scrolls at viewport center. `--selector`/`--testid` scrolls at element center. `--pos` scrolls at explicit viewport coordinates (mutually exclusive with selector).

### DOM (scroll-to — programmatic)

```bash
argus dom scroll-to app --selector "#footer"
argus dom scroll-to app --testid "footer"
argus dom scroll-to app --to 0,1000
argus dom scroll-to app --by 0,500
argus dom scroll-to app --selector ".panel" --to 0,1000
argus dom scroll-to app --selector ".panel" --by 0,500
```

Programmatically sets scroll position via `scrollTo()`/`scrollBy()`/`scrollIntoView()`. `--selector` alone scrolls element into view. `--to x,y` / `--by x,y` alone scrolls the viewport. Combine `--selector` with `--to`/`--by` to scroll within a scrollable container. Returns `{ scrollX, scrollY }`.

### Emulation

```bash
argus page emulation set app --device iphone-14
argus page emulation set app --device pixel-7
argus page emulation set app --device ipad-mini
argus page emulation set app --device desktop-1440
argus page emulation set app --device desktop-1600
argus page emulation set app --width 1600 --height 900
argus page emulation set app --device iphone-14 --width 500
argus page emulation set app --width 800 --height 600 --dpr 2 --mobile --touch
argus page emulation set app --device iphone-14 --ua "Custom UA"
argus page emu set app --device iphone-14          # alias
argus page emulation clear app
argus page emulation status app
argus page emulation status app --json
```

Emulates device viewport (width/height/DPR/mobile), touch, and user-agent on the watcher-attached page. `--device` selects a preset; `--width`, `--height`, `--dpr`, `--mobile`/`--no-mobile`, `--touch`/`--no-touch`, `--ua` override individual fields. State persists until cleared (survives detach/reattach). Available presets: `iphone-14`, `iphone-15-pro-max`, `pixel-7`, `ipad-mini`, `desktop-1440`, `desktop-1600`.

### Throttle

```bash
argus throttle set app 4
argus throttle set app 6
argus throttle clear app
argus throttle status app
argus throttle status app --json
```

CPU throttling via CDP. `set <rate>` applies a slowdown multiplier (1 = none, 4 = 4x). State persists until cleared (survives detach/reattach).

### Targets / Pages

```bash
argus page ls --id app
argus page ls --type iframe --id app
argus page ls --tree --id app
argus page open --url http://example.com --id app
argus page reload --id app
argus page reload <targetId> --param foo=bar
argus page activate <targetId>
argus page close <targetId>
argus reload app                  # shortcut: reload watcher's attached page
argus reload app --ignore-cache
```

---

## Config Defaults

Load defaults for `argus start`, `argus chrome start`, and `argus watcher start` from config file.

Auto-discovery: `.argus/config.json`, `.config/argus.json`, `argus.config.json`, `argus/config.json`

- `--config <path>` for explicit file
- CLI flags override config
- `argus config init` creates starter config

Example:

```json
{
	"chrome": {
		"start": { "url": "http://localhost:3000", "devTools": true }
	},
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"inject": { "file": "./scripts/debug.js" }
		}
	}
}
```

Script injection runs custom JS on attach and page navigation. See [INJECT.md](./reference/INJECT.md).

---

## Programmatic Watcher (Node API)

Use `@vforsh/argus-watcher` to create watchers from code.

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title}`)
})

await close()
```

---

## Troubleshooting

**Chrome binary not found** — Set `ARGUS_CHROME_BIN` to absolute path.

**Watcher can't attach (CDP)** — Check `--chrome-port` matches Chrome's port. Probe: `argus chrome status --port 9222`

**Reload with params fails** — Only http/https targets (not `chrome://`, `devtools://`).

**Wrong target matched** — Use `--type iframe` or `--origin`. See [IFRAMES.md](./reference/IFRAMES.md).

**Extension: "Native host has exited"** — Reinstall: `argus extension setup <EXTENSION_ID>`. Check Node version.

**Extension: can't connect** — Reload extension in `chrome://extensions`.

**Extension: can't eval in cross-origin iframe** — Use helper script. See [IFRAMES.md](./reference/IFRAMES.md).

---

## Reference (specialized topics)

- [EXTENSION.md](./reference/EXTENSION.md) — Extension workflow (non-CDP debugging)
- [EXTENSION_IFRAME_EVAL.md](./reference/EXTENSION_IFRAME_EVAL.md) — Cross-origin iframe eval in extension mode
- [EVAL.md](./reference/EVAL.md) — Polling, flags, iframe eval
- [IFRAMES.md](./reference/IFRAMES.md) — Target selection, cross-origin eval
- [INJECT.md](./reference/INJECT.md) — Script injection on watcher attach
