---
name: argus
description: Guides use of the Argus CLI to debug local web apps via Chrome CDP or the Argus Chrome extension (start Chrome/watcher, select targets including iframes, tail logs, eval JavaScript, and capture screenshots).
---

## Argus CLI

Debug local web apps via Chrome CDP or extension. Logs, eval, screenshots, target management.

---

## CDP Workflow (Recommended)

Launch Chrome with CDP enabled, auto-select targets via `--url` matching.

```bash
# 1) Start app
npm run dev && export APP_URL="http://localhost:3000"

# 2) Start Chrome with CDP (uses 9222 if available; prints port)
argus chrome start --url "$APP_URL"

# 3) Start watcher
argus watcher start --id app --url "$APP_URL" --chrome-port 9222

# 4) Use CLI
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

### Logs

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Error|Exception" --ignore-case
argus logs app --source console
argus logs app --json          # NDJSON output
```

### Tail (follow)

```bash
argus tail app
argus tail app --levels error --json
argus tail app --timeout 30000 --limit 200
```

### Eval

```bash
argus eval app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "document.title" --json
```

Full eval docs (polling, flags, iframe): [EVAL.md](./reference/EVAL.md)

### Screenshots

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
```

### Targets / Pages

```bash
argus page targets --id app
argus page targets --type iframe --id app
argus page open --url http://example.com --id app
argus page reload <targetId> --id app
argus page reload <targetId> --id app --param foo=bar
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
			"artifacts": "./artifacts"
		}
	}
}
```

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
