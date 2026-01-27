---
name: argus
description: Use the argus CLI to launch Chrome with CDP, start a local watcher, open/reload tabs, fetch/tail console logs, evaluate JS in the connected page, and capture screenshots. Use when debugging a local web app via Chromium CDP or Chrome extension, or when you need scripted access to watcher logs/eval/screenshot outputs.
compatibility: Requires Node 18+ (WebSocket), a Chromium-based browser, and localhost HTTP access (watcher + CDP).
---

## What this skill covers

- **Starting Chrome** with CDP enabled (`argus chrome start`)
- **Starting a watcher** in CDP mode or extension mode (`argus watcher start`)
- **Page commands** to open/reload tabs (`argus page open`, `argus page reload`)
- **Fetching logs** (one-shot + follow) (`argus logs`, `argus tail`)
- **Evaluating JS** in the connected page (`argus eval`)
- **Screenshots** (full page or element) (`argus screenshot`)
- **Iframe targeting** with `--type`, `--origin`, `--target`, `--parent` filters
- **Extension mode** for debugging without `--remote-debugging-port`
- **Iframe helper script** for cross-origin iframe eval in extension mode (`argus iframe-helper`)

## Quick workflow (recommended)

Run these in separate terminals so each long-running process can keep running.

**Two modes available:**

- **CDP mode** (default): Launch Chrome with `argus chrome start`, use `--url` matching
- **Extension mode**: Debug any tab in your regular Chrome using the Argus extension

### 0) Start your dev/dist server (capture the URL)

Start your app the usual way (project-specific), and capture the URL it prints (use the same URL for Chrome + the watcher).

```bash
# examples (pick the one your project uses)
npm run dev
# npm run start
# npm run preview

# capture the URL your app is serving on
export APP_URL="http://localhost:3000"
```

### 1) Start Chrome (CDP)

```bash
argus chrome start --url "$APP_URL"
```

- **Port behavior**: uses **9222** if available; otherwise chooses a free ephemeral port and prints it.
- **Keep it running**: this command stays alive until Ctrl+C; it cleans up the temp profile on exit.

If you want a snapshot of your default profile (copied into a temp dir):

```bash
argus chrome start --profile default-full
```

If you want DevTools opened immediately:

```bash
argus chrome start --dev-tools
```

### 2) Start a watcher

Use the **CDP port printed by Chrome** (9222 or the ephemeral fallback).

```bash
argus watcher start --id app --url "$APP_URL" --chrome-port 9222
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
			"devTools": true
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
argus chrome start --config .argus/config.json
argus chrome start --url http://localhost:3000
argus chrome start --from-watcher app
argus chrome start --dev-tools
argus chrome start --json
```

- **`--url <url>`**: open this URL on launch.
- **`--from-watcher <watcherId>`**: looks up the watcher in the local registry and uses its `match.url` as the startup URL.
- **`--dev-tools`**: auto-open DevTools for new tabs.
- **`--config <path>`**: load defaults from an Argus config file.
- **`--json`**: prints `{ chromePid, cdpHost, cdpPort, userDataDir, startupUrl }`.

## Starting the watcher (details)

### CDP mode (default)

```bash
argus watcher start
argus watcher start --config .argus/config.json
argus watcher start --id app --url localhost:3000
argus watcher start --id app --url localhost:3000 --no-page-indicator
argus watcher start --id app --url localhost:3000 --chrome-host 127.0.0.1 --chrome-port 9222
argus watcher start --id app --url localhost:3000 --json
```

Notes:

- **Chrome must already be running** with CDP enabled at `--chrome-host:--chrome-port`.
- The watcher process runs until Ctrl+C.
- The in-page watcher indicator badge is **enabled by default**; use `--no-page-indicator` to disable.

### Extension mode

```bash
argus watcher start --id app --source extension
argus watcher start --id app --source extension --json
```

Notes:

- **No Chrome flags needed** - works with your regular Chrome.
- Requires the Argus extension to be installed and the Native Messaging host configured.
- Tab selection is done via the extension popup (no `--url` matching).
- See "Extension mode" section below for setup instructions.

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
- **`--no-await`**: don't await returned promises.
- **`--interval <ms|duration>`**: re-run periodically (`500`, `250ms`, `3s`, `2m`).
- **`--count <n>`**: stop after N iterations (requires `--interval`).
- **`--until <condition>`**: stop when local condition becomes truthy (requires `--interval`).
    - Local context: `{ result, exception, iteration, attempt }`.
- **`--iframe <selector>`**: eval in a cross-origin iframe via postMessage (requires helper script).
- **`--iframe-timeout <ms>`**: timeout for iframe response (default: 5000).

Example: poll until a title is ready:

```bash
argus eval app 'document.title' --interval 250ms --until 'result === "ready"'
```

Example: eval in a cross-origin iframe (extension mode):

```bash
# First, include the helper script in your iframe (one-time setup)
argus iframe-helper --out src/argus-helper.js

# Then eval in the iframe
argus eval app 'window.gameState' --iframe 'iframe#game'
```

## Screenshots

Full page screenshot:

```bash
argus screenshot app --out shot.png
```

Element-only screenshot:

```bash
argus screenshot app --selector "canvas" --out canvas.png
```

Notes:

- `--out` is interpreted by the watcher (typically relative to its artifacts dir). Use `--json` to capture the resolved `outFile` path.

## Working with iframes

When your app runs inside an iframe (e.g., embedded games, widgets), special targeting is needed to attach to the iframe instead of the parent page.

> **Extension mode note**: Cross-origin iframe eval requires a helper script. See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md).

### The problem

Simple URL matching (`--url localhost:3007`) can match the wrong target when:

- The parent page includes the iframe URL in its query string (e.g., `?game_url=https://localhost:3007`)
- Multiple targets have similar URLs

### Targeting options

Use these options with `argus watcher start` to precisely target iframes:

**`--type iframe`** - Only match targets with type "iframe":

```bash
argus watcher start --id game --type iframe --url localhost:3007
```

**`--origin <origin>`** - Match URL origin only (ignores query params in other pages):

```bash
argus watcher start --id game --origin https://localhost:3007
```

**`--target <targetId>`** - Connect to a specific target by ID:

```bash
# First, list targets to find the ID
argus page targets --type iframe

# Then connect directly
argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344
```

**`--parent <pattern>`** - Match only targets whose parent URL contains this pattern:

```bash
argus watcher start --id game --type iframe --parent yandex.ru
```

### Discovering targets

List all targets with parent information:

```bash
argus page targets
```

Show targets as a tree with parent-child relationships:

```bash
argus page targets --tree
```

Filter to iframes only:

```bash
argus page targets --type iframe
```

### Example: embedded game debugging

```bash
# Terminal 1: Start Chrome
argus chrome start --url "https://yandex.ru/games/app/123"

# Terminal 2: Start watcher for the iframe
argus watcher start --id game --type iframe --url localhost:3007

# Terminal 3: Debug the game
argus logs game --levels error,warning
argus eval game 'window.gameState'
argus screenshot game --out game.png
```

### Watcher output with iframe info

When attached to an iframe, the watcher shows type and parent info:

```
[game] CDP attached: My Game (https://localhost:3007/dev/index.html) (type: iframe)
```

### Programmatic targeting

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	id: 'game',
	match: {
		url: 'localhost:3007',
		type: 'iframe', // Only match iframes
		// origin: 'https://localhost:3007',  // Or use origin matching
		// targetId: 'CC11...',   // Or direct target ID
		// parent: 'yandex.ru',   // Or filter by parent URL
	},
	chrome: { host: '127.0.0.1', port: 9222 },
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title} (type: ${target?.type}, parent: ${target?.parentId})`)
})
```

## Extension mode (no `--remote-debugging-port` needed)

Extension mode lets you debug any Chrome tab without launching Chrome with special flags. Useful when:

- You can't restart Chrome with `--remote-debugging-port`
- You want to debug tabs in your normal browsing session
- The app is already running in a regular Chrome window

### Setup (one-time)

1. **Load the extension** in Chrome:

    ```bash
    # Build the extension
    cd packages/argus-extension && npm run build
    ```

    - Open `chrome://extensions`
    - Enable **Developer mode**
    - Click **Load unpacked** → select `packages/argus-extension`
    - Copy the **Extension ID** (e.g., `kkoefnlnjlnlbohcifcbkpgmjaokmipi`)

2. **Install the Native Messaging host**:

    ```bash
    argus extension setup <EXTENSION_ID>
    ```

    To verify installation:

    ```bash
    argus extension status
    ```

### Usage

```bash
# Start watcher in extension mode
argus watcher start --id app --source extension
```

Then in Chrome:

1. Click the **Argus extension icon** in the toolbar
2. Click **Attach** on the tab you want to debug
3. Chrome shows an orange "debugging" bar (normal, can't be disabled)

Now use the CLI as usual:

```bash
argus list                      # Shows watcher with source: extension
argus logs app                  # View console logs
argus tail app                  # Follow logs in real-time
argus eval app "document.title" # Evaluate JavaScript
```

### Extension mode limitations

- **Orange debugging bar**: Chrome shows "Argus is debugging this browser" - this is a security feature and cannot be disabled.
- **One debugger per tab**: Only one extension/DevTools can debug a tab at a time.
- **Tab must stay open**: Closing a tab detaches the debugger.
- **No automatic target matching**: You manually select which tab to attach via the extension popup (unlike CDP mode's `--url` matching).
- **Cross-origin iframes**: Cannot directly eval in cross-origin iframes. Use the `argus iframe-helper` command to generate a postMessage bridge script. See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md) for details.

### Programmatic (Node API)

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	id: 'app',
	source: 'extension', // Use extension mode instead of CDP
	// No chrome or match options needed - extension handles tab selection
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title}`)
})
```

## Iframe Helper (extension mode)

Generate a helper script for cross-origin iframe eval via postMessage:

```bash
argus iframe-helper                        # Output to stdout
argus iframe-helper --out src/helper.js   # Write to file
argus iframe-helper --iife --no-log       # IIFE-wrapped, no console.log
argus iframe-helper --namespace myapp     # Custom message prefix
```

Include this script in your iframe to enable eval from the parent page. See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md) for full usage details.

## Common troubleshooting

- **Chrome binary not found**: set `ARGUS_CHROME_BIN` to an absolute path.
- **Watcher can't attach**: confirm the CDP endpoint (`argus chrome status --host 127.0.0.1 --port 9222`) and ensure your watcher's `--chrome-port` matches.
- **Page reload with params fails**: only supported for http/https targets (not `chrome://`, `devtools://`, etc.).
- **Wrong target matched (iframe issue)**: Use `--type iframe` or `--origin` to avoid matching parent pages that include your URL in query params.
- **Extension mode: "Native host has exited"**: Reinstall the host manifest with `argus extension setup <EXTENSION_ID>`. Ensure you're using the same Node version.
- **Extension mode: can't connect**: Reload the extension in `chrome://extensions` and try again.
- **Extension mode: can't eval in iframe**: Cross-origin iframes need the helper script. Run `argus iframe-helper --out helper.js` and include it in your iframe.
