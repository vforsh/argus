---
name: argus
description: Guides use of the Argus CLI to debug and inspect web apps via Chrome CDP or the Argus Chrome extension (start Chrome/watcher, select targets including iframes, tail logs, eval JavaScript, inspect runtime code, and capture screenshots).
---

## Argus CLI

Debug local web apps via Chrome CDP or extension. Logs, eval, runtime code inspection, screenshots, target management.

Install/run:

```bash
npm i -g @vforsh/argus
argus --help
npx -y @vforsh/argus --help
```

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
argus start --id app --auth-from extension-2
argus start --id app --auth-from extension-2 --url https://target.app/
argus start --id app --url localhost:3000 --dev-tools
argus start --id app --url localhost:3000 --profile temp
argus start --id app --type page --headless
argus start --id app --url localhost:3000 --inject ./debug.js
argus start --id app --url localhost:3000 --no-page-indicator
argus start --id app --url localhost:3000 --json
```

`--url` opens in Chrome and matches the watcher target. `--auth-from` clones cookies + storage from another watcher into a fresh temp Chrome session before the new watcher attaches; add `--url` to override the final destination after hydration. Accepts all chrome options (`--profile`, `--dev-tools`, `--headless`) and watcher options (`--type`, `--origin`, `--target`, `--parent`, `--inject`, `--artifacts`, `--no-page-indicator`). CDP port is wired automatically.

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

`--url` matches target URL substring. `--origin` matches protocol+host+port only. `--target` connects to a specific Chrome target ID. `--type` filters by target type (page, iframe, worker). `--parent` filters by parent target URL. `--inject` runs a JS file on attach + navigation. `--no-page-indicator` hides the in-page overlay in both CDP and extension mode — use this when capturing screenshots so the badge doesn't end up in the image.

In extension mode, each attached browser tab gets its own watcher id. The popup can switch that watcher's active target between the top page and discovered iframes inside the same attached tab. `argus list` shows the tab-scoped watcher ids, and `argus page ls --id <watcher>` shows the page/iframe targets for that watcher only.

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

### Runtime Code

```bash
argus code ls app
argus code ls app --pattern inline
argus code read inline://42 --id app
argus code grep '/featureFlag/' --id app
argus code grep showLogsByHost --id app --pretty
argus code deminify http://127.0.0.1:3333/app.js --id app
argus code strings app --url app.js
argus code strings app --url app.js --kind url,identifier --match '/admin\\/api/'
```

`code ls` lists runtime JS/CSS resources discovered through CDP. `code read` returns line-numbered source. `code grep` searches sources with plain strings or `/regex/flags`, skips stale stylesheet handles instead of aborting the whole search, and `--pretty` renders clipped context for humans. `code deminify` pretty-prints a runtime resource. `code strings` extracts high-signal string literals such as URLs, keys, and camelCase identifiers, ranks the most reverse-engineering-friendly values first, and supports `--kind` / `--match` for narrower scans. Full runtime-code docs: [RUNTIME_CODE.md](./reference/RUNTIME_CODE.md)

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

When the active extension target is an iframe, plain screenshots capture the iframe viewport only. `--selector` also works inside the selected iframe and crops that element from the rendered page output.

### Network

```bash
argus net app --since 5m
argus net app --grep api
argus net clear app
argus net watch app --reload --settle 3s
argus net watch app --reload --settle 3s --ignore-pattern /poll
argus net watch app --reload --settle 3s --max-timeout 30s
argus net extension --scope selected --host stark.games --resource-type Fetch
argus net extension --first-party --slow-over 500ms --status 4xx
argus net extension --large-over 100kb --mime application/json
argus net export app --out boot.har
argus net export app --reload --settle 3s --out boot.har
argus net show 42 app
argus net show 90829.507 extension --json
argus net summary app
argus net app --json
argus net tail app
argus net tail app --grep api --json
```

`net clear` resets the watcher’s buffered requests so the next inspection starts clean. `net watch` now waits for an actual quiet window: it tails matching requests until no new matches arrive for `--settle`, and `--max-timeout` stops the watch if the page never settles. `net export --format har` writes the current buffer, or a fresh reload capture, as a HAR file. `net show` drills into one buffered request by Argus id or raw CDP request id, including redacted request/response headers, initiator, redirect chain, cache/service-worker flags, remote endpoint, and timing phases. `net`/`net tail`/`net watch`/`net export` also support richer filtering: host, method, status or status class (`2xx`), resource type, MIME prefix, first-party vs third-party, failed-only, slow-over, large-over, and target scope. Scope is explicit: use `--scope selected` or `--frame selected` when you want iframe-only traffic in extension mode, but reload-driven `net watch` / `net export` intentionally reject selected-frame scope.

### Storage

```bash
argus storage local get app theme
argus storage local set app theme dark
argus storage local remove app theme
argus storage local ls app
argus storage local clear app
argus storage session get app draftId
argus storage session set app draftId abc123
argus storage session remove app draftId
argus storage session ls app
argus storage session clear app
```

### Auth

```bash
argus auth cookies list app
argus auth cookies list app --show-values --json
argus auth cookies ls app --for-origin --exclude-tracking
argus auth cookies get app session --domain .example.com --path /
argus auth cookies get app session --domain .example.com --path / --show-value --json
argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only
argus auth cookies set app preview 1 --domain app.example.com --path / --session --json
argus auth cookies delete app session --domain .example.com --path /
argus auth cookies clear app --for-origin
argus auth cookies clear app --site --auth-only
argus auth cookies clear app --domain example.com --session-only --json
argus auth cookies clear app --browser-context
argus auth export-cookies app --format netscape
argus auth export-cookies app --for-origin --exclude-tracking
argus auth export-state app --out auth.json
argus auth export app --out auth.json
argus auth load-state app --in auth.json
argus auth export-state extension-2 | argus auth load-state app --in -
argus auth load app --in auth.json --url https://target.app/
argus auth clone extension-2 --to app
argus chrome start --auth-state auth.json
argus start --id app --auth-from extension-2
```

`auth cookies list`/`ls` lists browser cookies for the attached page, with optional domain/flag filters. `auth cookies get` resolves one cookie by exact `name + domain + path` identity. `auth cookies set` / `delete` mutate cookies through CDP instead of `document.cookie`, so HttpOnly/session metadata stays intact. `auth cookies clear` requires an explicit scope: current origin host, current site domain, an explicit domain suffix, or the whole browser context; add `--session-only` or `--auth-only` to narrow the deletion slice. `--for-origin` keeps first-party cookies for the current page origin, and `--exclude-tracking` hides common analytics cookies such as `_ga` / `_ym`. `auth export-cookies` emits cookie jars for companion CLIs (`netscape`, `json`, or `header`) and supports the same filters. `auth export-state`/`auth export` writes a portable JSON snapshot with cookies, `localStorage`, `sessionStorage`, and a metadata block (`exportedAt`, watcher provenance, page title/site domain, cookie count, auth-looking cookie names, recommended startup URL); stdout is pipe-friendly by default. `auth load-state`/`auth load` rehydrates that snapshot into the currently attached watcher tab, including `--in -` for stdin. `auth clone` skips the intermediate file and copies auth state directly between watchers. `chrome start --auth-state` loads a snapshot into a fresh temp Chrome profile, while `start --auth-from` does the same and immediately attaches a watcher.

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
argus dom info app --ref e3
argus snapshot app
argus snapshot app --interactive
argus snapshot app --selector "form" --depth 3
argus snapshot app --testid "login-form"
argus locate role app button --name "Submit"
argus locate text app "Continue"
argus locate label app "Email" --action fill --value "me@example.com"
```

`--testid <id>` is shorthand for `--selector "[data-testid='<id>']"` and works on all commands that accept `--selector`. Cannot be combined with `--selector`.

`dom tree` returns a DOM subtree; control depth with `--depth` (default 2), cap nodes with `--max-nodes`. `dom info` returns detailed element info (attributes, outerHTML, box model) and also accepts `--ref <elementRef>`. `snapshot` (aliases: `snap`, `ax`) captures an accessibility tree; `--interactive` / `-i` filters to buttons, links, inputs, etc.

`snapshot` and `locate` emit stable watcher-local refs such as `e5`, which you can feed back into ref-aware commands instead of repeating selectors. `locate role|text|label` is the semantic lookup layer: match by accessibility role + name, visible/accessible text, or form label/accessibility name. Use `--action click|fill|focus|hover` to run the follow-up action immediately; `--value` is required with `--action fill`.

### Interact (top-level)

```bash
argus click app --selector "button.submit"
argus click app --testid "submit-btn"
argus click app --ref e5
argus click app --selector ".delayed-btn" --wait 5s
argus click app --pos 100,200
argus click app --selector "#item" --button right
argus click app --pos 100,200 --button middle
argus hover app --selector ".menu-item"
argus hover app --ref e5
argus hover app --selector ".item" --all
argus fill app --selector "#username" "Bob"
argus fill app --testid "username" "Bob"
argus fill app --ref e7 "Bob"
argus fill app --selector "textarea" "New content"
argus fill app --selector "input[type=text]" --all "reset"
argus fill app --selector "#desc" --value-file ./description.txt
echo "hello" | argus fill app --selector "#input" --value-stdin
argus fill app --selector "#input" - < value.txt
argus fill app --selector ".dynamic-input" "text" --wait 3s
argus keydown app --key Enter
argus keydown app --key a --selector "#input"
argus keydown app --key a --modifiers shift,ctrl
argus scroll-to app --selector "#footer"
argus scroll-to app --testid "footer"
argus scroll-to app --to 0,1000
argus scroll-to app --by 0,500
argus scroll-to app --selector ".panel" --to 0,1000
argus scroll-to app --selector ".panel" --by 0,500
```

`click` clicks at coordinates (`--pos x,y`) or on elements matching `--selector`/`--testid`/`--ref`. `--button left|middle|right` selects the mouse button (default: left). `hover` dispatches mouseover/mouseenter on matched elements and also accepts `--ref`. `fill` sets value on input/textarea/contenteditable; triggers framework-compatible events (focus → input → change → blur) and accepts `--selector`, `--testid`, `--name`, or `--ref`. Value can come from inline arg, `--value-file <path>`, or `--value-stdin` (also `-` as value arg). `keydown` dispatches keyboard events; use `--selector` to focus an element first, `--modifiers` for combos. `scroll-to` programmatically scrolls via `scrollTo()`/`scrollBy()`/`scrollIntoView()`. `--selector` alone scrolls element into view. `--to x,y` / `--by x,y` alone scrolls the viewport. Combine `--selector` with `--to`/`--by` to scroll within a scrollable container. Returns `{ scrollX, scrollY }`.

`--wait <duration>` (on click, fill) polls for the selector to appear before executing the action — useful for reactive UIs where elements render after navigation/SPA transitions. Duration format: `5s`, `500ms`, `2m`. `--text` filters by textContent, `--all` allows multiple matches.

### Dialogs

```bash
argus dialog status app
argus dialog accept app
argus dialog dismiss app
argus dialog prompt app --text "updated value"
argus dialog status app --json
```

Browser JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`). `status` shows the current active dialog, if any. `accept` and `dismiss` resolve the active dialog. `prompt` accepts the active prompt dialog and submits `--text`. Only one dialog can be active at a time.

### DOM (interact)

```bash
argus dom focus app --selector "#input"
argus dom focus app --testid "search-box"
argus dom focus app --ref e5
argus dom set-file app --selector "input[type=file]" --file ./build.zip
argus dom upload app --selector "input[type=file]" --file ~/Downloads/test.zip
argus dom set-file app --selector "#upload" --file a.png --wait 5s
```

`dom focus` programmatically focuses an element via CDP (`DOM.focus`); useful before typing or keyboard interactions. It accepts `--selector`, `--testid`, or `--ref`. `dom set-file` (alias: `dom upload`) sets files on `<input type="file">` elements; `--wait` polls for selector. Path flags (`--file`, `--value-file`, `--html-file`, `--artifacts`, inject paths) all support `~/` expansion.

### DOM (scroll — emulate gesture)

```bash
argus dom scroll app --by 0,300
argus dom scroll app --selector ".panel" --by 0,200
argus dom scroll app --testid "feed" --by 0,500
argus dom scroll app --pos 400,300 --by 0,200
```

Emulates touch scroll gestures via CDP `Input.emulateTouchScrollGesture` — fires real wheel/scroll events. `--by dx,dy` is required (positive y = scroll down). Without `--selector` or `--pos`, scrolls at viewport center. `--selector`/`--testid` scrolls at element center. `--pos` scrolls at explicit viewport coordinates (mutually exclusive with selector).

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

## CLI Plugins

Argus can load optional CLI plugins that register extra top-level commands.

- Config: add `"plugins": ["<module-or-path>"]` to Argus config.
- Env: set `ARGUS_PLUGINS` to comma-separated specifiers/paths.
- Module contract: default export `{ apiVersion: 1, name, register(ctx) }`.
- TypeScript: import plugin types from `@vforsh/argus-plugin-api`.

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

**Watcher can't attach (CDP)** — Check `--chrome-port` matches Chrome's port. Probe: `argus chrome status --cdp 127.0.0.1:9222`

**Reload with params fails** — Only http/https targets (not `chrome://`, `devtools://`).

**Wrong target matched** — Use `--type iframe` or `--origin`. See [IFRAMES.md](./reference/IFRAMES.md).

**Extension: "Native host has exited"** — Reinstall: `argus extension setup <EXTENSION_ID>`. Check Node version.

**Extension: can't connect** — Reload extension in `chrome://extensions`.

**Extension: can't eval in cross-origin iframe** — Use helper script. See [IFRAMES.md](./reference/IFRAMES.md).

---

## Reference (specialized topics)

- [EXTENSION.md](./reference/EXTENSION.md) — Extension workflow (non-CDP debugging)
- [EXTENSION_IFRAME_EVAL.md](./reference/EXTENSION_IFRAME_EVAL.md) — Cross-origin iframe eval in extension mode
- [DIALOG.md](./reference/DIALOG.md) — Browser dialog status + handling
- [EVAL.md](./reference/EVAL.md) — Polling, flags, iframe eval
- [IFRAMES.md](./reference/IFRAMES.md) — Target selection, cross-origin eval
- [INJECT.md](./reference/INJECT.md) — Script injection on watcher attach
