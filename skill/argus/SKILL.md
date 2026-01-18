---
name: argus
description: Use the argus CLI to launch Chrome with CDP, start a local watcher, open/reload tabs, fetch/tail console logs, evaluate JS in the connected page, and capture screenshots. Use when debugging a local web app via Chromium CDP or when you need scripted access to watcher logs/eval/screenshot outputs.
compatibility: Requires Node 18+ (WebSocket), a Chromium-based browser, and localhost HTTP access (watcher + CDP).
---

## What this skill covers

- **Starting Chrome** with CDP enabled (`argus chrome start`)
- **Starting a watcher** that captures logs for matching pages (`argus watcher start`)
- **Page commands** to open/reload tabs (`argus page open`, `argus page reload`)
- **Fetching logs** (one-shot + follow) (`argus logs`, `argus tail`)
- **Evaluating JS** in the connected page (`argus eval`)
- **Screenshots** (full page or element) (`argus screenshot`)

## Quick workflow (recommended)

Run these in separate terminals so each long-running process can keep running.

### 1) Start Chrome (CDP)

```bash
argus chrome start --url http://localhost:3000
```

- **Port behavior**: uses **9222** if available; otherwise chooses a free ephemeral port and prints it.
- **Keep it running**: this command stays alive until Ctrl+C; it cleans up the temp profile on exit.

If Argus can’t find Chrome, set:

```bash
export ARGUS_CHROME_BIN="/absolute/path/to/chrome"
```

If you want a snapshot of your default profile (copied into a temp dir):

```bash
argus chrome start --default-profile
```

If you want DevTools opened immediately:

```bash
argus chrome start --dev-tools
argus chrome start --dev-tools-panel console
```

If Argus can’t find your Chrome user data dir for `--default-profile`, set:

```bash
export ARGUS_CHROME_USER_DATA_DIR="/absolute/path/to/Chrome/User Data"
```

### 2) Start a watcher

Use the **CDP port printed by Chrome** (9222 or the ephemeral fallback).

```bash
argus watcher start --id app --url localhost:3000 --chrome-port 9222
```

- **`--id`**: the name you’ll use for `logs`, `eval`, `screenshot`, etc.
- **`--url`**: a URL/pattern used to decide which pages to attach to for capturing logs.

### Config defaults (optional)

Argus can load defaults for `argus chrome start` and `argus watcher start` from a repo-local config file.

- Auto-discovery order: `.argus/config.json`, `argus.config.json`, `argus/config.json`.
- Use `--config <path>` to point at an explicit file (relative to `cwd` if not absolute).
- CLI options override config values.
- `watcher.start.artifacts` is resolved relative to the config file directory.
- Use `argus config init` to create a starter config file.

Example:

```json
{
	"$schema": "../schemas/argus.config.schema.json",
	"chrome": {
		"start": {
			"url": "http://localhost:3000",
			"devTools": true,
			"devToolsPanel": "console"
		}
	},
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromeHost": "127.0.0.1",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"pageIndicator": true
		}
	}
}
```

### 3) Use the CLI against the watcher

```bash
argus logs app --since 10m --levels error,warning
argus eval app 'location.href'
argus screenshot app --out shot.png
```

## Starting Chrome (details)

### Launch Chrome

```bash
argus chrome start
argus chrome start --url http://localhost:3000
argus chrome start --id app
argus chrome start --dev-tools
argus chrome start --dev-tools-panel console
argus chrome start --config .argus/config.json
argus chrome start --json
```

- **`--url <url>`**: open this URL on launch.
- **`--id <watcherId>`**: looks up the watcher in the local registry and uses its `match.url` as the startup URL.
- **`--dev-tools`**: auto-open DevTools for new tabs.
- **`--dev-tools-panel <panel>`**: open DevTools with a specific panel (`console`, `network`, `elements`).
- **`--config <path>`**: load defaults from an Argus config file.
- **`--json`**: prints `{ chromePid, cdpHost, cdpPort, userDataDir, startupUrl }`.

## Starting the watcher (details)

```bash
argus watcher start --id app --url localhost:3000
argus watcher start --id app --url localhost:3000 --no-page-indicator
argus watcher start --id app --url localhost:3000 --chrome-host 127.0.0.1 --chrome-port 9222
argus watcher start --config .argus/config.json
argus watcher start --id app --url localhost:3000 --json
```

Notes:

- **Chrome must already be running** with CDP enabled at `--chrome-host:--chrome-port`.
- The watcher process runs until Ctrl+C.
- The in-page watcher indicator badge is **enabled by default**; use `--no-page-indicator` to disable.

## Programmatic watcher (Node API)

Use `@vforsh/argus-watcher` when you want to create/start watchers from code (tests, scripts, custom tooling) instead of running `argus watcher start`.

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	// Same concept as `argus watcher start --id <id>`
	id: 'app',

	// Same concept as `--url` matching (controls which pages to attach to)
	match: { url: 'localhost:3000' },

	// CDP endpoint for the already-running Chrome instance
	chrome: { host: '127.0.0.1', port: 9222 },

	// Optional: persist artifacts (logs/traces/screenshots)
	artifacts: {
		base: '/tmp/argus/artifacts',
		logs: { enabled: true },
	},

	// Optional knobs:
	// bufferSize, host/port (bind), net, ignoreList, location, pageIndicator, ...
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title ?? '(unknown)'}`)
})

// later
await close()
```

For the full `startWatcher(options)` surface (and the `WatcherHandle.events` emitter), see `packages/argus-watcher/README.md`.

## Page commands (open, reload)

### List targets (to get `targetId`)

```bash
argus page targets --type page --id app
```

### Open a new tab

```bash
argus page open --url http://example.com --id app
argus page open --url localhost:3000 --id app
```

- If the URL has no scheme, Argus prepends `http://`.

### Reload a tab

`targetId` is the **Chrome target identifier** (usually a specific tab) returned by CDP. Get it from `argus page targets` (or `argus chrome targets`); it’s the first column / the `.id` field in `--json` output.

Simple reload:

```bash
argus page reload <targetId> --id app
```

Reload while overwriting query params (navigates to a new URL):

```bash
argus page reload <targetId> --id app --param foo=bar --param baz=qux
argus page reload <targetId> --id app --params "a=1&b=2"
```

Notes:

- Query param updates only work for **http/https** targets.
- `--param` / `--params` use **overwrite semantics** (set/replace keys).

## Fetching logs

### One-shot logs (history)

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Unhandled|Exception" --ignore-case
argus logs app --source console
argus logs app --json
argus logs app --json-full
```

### Tail logs (follow / long-poll)

```bash
argus tail app
argus tail app --levels error --json
argus tail app --timeout 30000 --limit 200
```

Notes:

- `tail` runs until you stop it (Ctrl+C).
- `--json` / `--json-full` emit **newline-delimited JSON** (NDJSON).

## Eval (run JS in the connected page)

```bash
argus eval app 'location.href'
argus eval app 'fetch("/ping").then(r => r.status)'
argus eval app 'document.title' --json
```

Useful flags:

- **`--no-fail-on-exception`**: keep exit code 0 when the evaluation throws.
- **`--retry <n>`**: retry failed evaluations up to N times.
- **`--timeout <ms>`**: watcher-side eval timeout.
- **`--no-await`**: don’t await returned promises.
- **`--interval <ms|duration>`**: re-run periodically (`500`, `250ms`, `3s`, `2m`).
- **`--count <n>`**: stop after N iterations (requires `--interval`).
- **`--until <condition>`**: stop when local condition becomes truthy (requires `--interval`).
    - Local context: `{ result, exception, iteration, attempt }`.

Example: poll until a title is ready:

```bash
argus eval app 'document.title' --interval 250ms --until 'result === "ready"'
```

## Screenshots

Full page screenshot:

```bash
argus screenshot app --out shot.png
```

Element-only screenshot:

```bash
argus screenshot app --selector "body" --out body.png
```

Notes:

- `--out` is interpreted by the watcher (typically relative to its artifacts dir). Use `--json` to capture the resolved `outFile` path.

## Common troubleshooting

- **Chrome binary not found**: set `ARGUS_CHROME_BIN` to an absolute path.
- **Watcher can’t attach**: confirm the CDP endpoint (`argus chrome status --host 127.0.0.1 --port 9222`) and ensure your watcher’s `--chrome-port` matches.
- **Page reload with params fails**: only supported for http/https targets (not `chrome://`, `devtools://`, etc.).
