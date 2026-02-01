---
name: argus
description: Guides use of the Argus CLI to debug local web apps via Chrome CDP or the Argus Chrome extension (start Chrome/watcher, select targets including iframes, tail logs, eval JavaScript, and capture screenshots).
---

## Argus CLI

Debug local web apps via Chrome CDP or extension. Logs, eval, screenshots, target management.

---

## CDP Workflow (Recommended)

Launch Chrome with CDP enabled, auto-select targets via `--url` matching.

**CRITICAL for agents:** `argus watcher start` and `argus chrome start` are **long-running processes that never exit on their own**. You **MUST** start them in the background (e.g., `run_in_background: true` in Bash tool). If you run them in the foreground, they will block indefinitely and you will not be able to execute any further commands.

```bash
# 1) Start app
npm run dev && export APP_URL="http://localhost:3000"

# 2) Start Chrome with CDP in background (uses 9222 if available; prints port)
argus chrome start --url "$APP_URL"  # Run with run_in_background: true

# 3) Start watcher in background — MUST use run_in_background: true (blocks forever otherwise)
argus watcher start --id app --url "$APP_URL" --chrome-port 9222  # run_in_background: true

# 4) Use CLI (these are quick commands, run normally)
argus logs app --since 10m --levels error,warning
argus tail app
argus eval app "location.href"
argus screenshot app --out shot.png
```

Chrome variants:

```bash
argus chrome start --dev-tools
argus chrome start --profile default-full
argus chrome start --json
argus chrome start --from-watcher app
```

---

## Extension Workflow

Debug normal Chrome session without CDP flags.

### One-Time Setup

```bash
# 1) Build extension
cd packages/argus-extension && npm run build

# 2) Load in Chrome
#    chrome://extensions → Developer mode → Load unpacked → select packages/argus-extension
#    Copy Extension ID (e.g. kkoefnlnjlnlbohcifcbkpgmjaokmipi)

# 3) Install native host
argus extension setup <EXTENSION_ID>
argus extension status
```

### Usage

1. Click Argus extension icon
2. Click **Attach** on target tab
3. Chrome shows orange "debugging" bar (expected)

```bash
argus list
argus logs extension
argus eval extension "document.title"
```

### Limitations

- Debugging bar can't be hidden (Chrome security)
- One debugger per tab
- Tab must stay open
- Manual tab selection (no `--url` matching)
- Cross-origin iframes: use helper script (see [IFRAMES.md](./reference/IFRAMES.md))

---

## Commands Cheat Sheet

### Chrome Start

**Long-running process — must use `run_in_background: true`.**

```bash
argus chrome start --url http://localhost:3000
argus chrome start --from-watcher app
argus chrome start --dev-tools
argus chrome start --headless
```

`--from-watcher` reads URL from a registered watcher's config. `--headless` runs without a visible window.

### Watcher Start

**Long-running process — must use `run_in_background: true`.**

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

`--url` matches target URL substring. `--origin` matches protocol+host+port only. `--target` connects to a specific Chrome target ID. `--type` filters by target type (page, iframe, worker). `--parent` filters by parent target URL. `--inject` runs a JS file on attach + navigation. `--no-page-indicator` hides the in-page overlay.

### Logs

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Error|Exception" --ignore-case
argus logs app --source console
argus logs app --json          # bounded JSON preview
argus logs app --json-full     # full JSON (can be large)
```

### Tail (follow)

**Note:** `tail` is a long-running streaming command. Run in background if you need to continue other work.

```bash
argus logs tail app
argus logs tail app --levels error --json
argus logs tail app --timeout 30000
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
argus dom tree app --selector "div" --all --depth 3
argus dom info app --selector "#root"
argus dom info app --selector "div" --all --json
argus snapshot app
argus snapshot app --interactive
argus snapshot app --selector "form" --depth 3
```

`dom tree` returns a DOM subtree; control depth with `--depth` (default 2), cap nodes with `--max-nodes`. `dom info` returns detailed element info (attributes, outerHTML, box model). `snapshot` (aliases: `snap`, `ax`) captures an accessibility tree; `--interactive` / `-i` filters to buttons, links, inputs, etc.

### DOM (interact)

```bash
argus dom click app --selector "button.submit"
argus dom hover app --selector ".menu-item"
argus dom fill app --selector "#username" "Bob"
argus dom fill app --selector "textarea" "New content"
argus dom fill app --selector "input[type=text]" --all "reset"
argus dom keydown app --key Enter
argus dom keydown app --key a --selector "#input"
argus dom keydown app --key a --modifiers shift,ctrl
```

`dom fill` sets value on input/textarea/contenteditable; triggers framework-compatible events (focus → input → change → blur). `--text` filters by textContent, `--all` fills multiple matches. `dom keydown` dispatches keyboard events; use `--selector` to focus an element first, `--modifiers` for combos.

### Targets / Pages

```bash
argus page ls --id app
argus page ls --type iframe --id app
argus page ls --tree --id app
argus page open --url http://example.com --id app
argus page reload --attached --id app
argus page reload <targetId> --param foo=bar
argus page activate <targetId>
argus page close <targetId>
argus reload app                  # shortcut: reload watcher's attached page
argus reload app --ignore-cache
```

---

## Config Defaults

Load defaults for `argus chrome start` and `argus watcher start` from config file.

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

- [EVAL.md](./reference/EVAL.md) — Polling, flags, iframe eval
- [IFRAMES.md](./reference/IFRAMES.md) — Target selection, cross-origin eval
- [INJECT.md](./reference/INJECT.md) — Script injection on watcher attach
