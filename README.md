# Argus

Terminal-first debugging for Chromium apps. Argus lets you inspect a live page without living in DevTools: tail console logs, inspect DOM, run JavaScript, poke storage, capture screenshots, and debug iframes from the CLI.

Use it when the app is already running and you want fast runtime visibility from a shell, script, or agent.

## Why Argus

- **Live app debugging from the terminal**: query the page you already have open instead of spinning up a browser automation suite
- **CDP + watcher model**: connect once, then use short commands for logs, DOM, eval, network, screenshots, and traces
- **Good for humans and scripts**: terminal-friendly text by default, `--json` everywhere for automation
- **Better than tab-hopping**: keep logs, page state, and quick probes in one CLI workflow

## When To Use It

**Use Argus when you want to:**

- inspect a local app that is already running
- debug state, DOM, or logs from the terminal
- drive quick ad-hoc interactions without writing a Playwright test
- hook AI agents or shell scripts into a live Chromium page

**Use something else when you want to:**

- write full browser tests with assertions and fixtures: use Playwright/Puppeteer
- manually step through complex UI in the browser: use DevTools
- perform stable end-to-end regression testing in CI: use Playwright

Argus lives in the gap between “open DevTools and click around” and “write a full automation harness”.

## Quickstart

### Run from this repo

```bash
bun install
npm run build:packages
bun packages/argus/src/bin.ts --help
```

For repeated local use, link the CLI:

```bash
bun link packages/argus
argus --help
```

### Install globally

```bash
npm install -g @vforsh/argus
argus --help
```

### Run without installing

```bash
npx -y @vforsh/argus --help
```

## Fastest Path

Start Chrome and attach a watcher in one command:

```bash
argus start --id app --url http://localhost:3000
```

This command is long-running. It keeps Chrome and the watcher alive until you stop it.

In another terminal:

```bash
argus list
argus logs tail app
argus eval app "document.title"
argus screenshot app --out shot.png
```

If you want separate control over Chrome and the watcher:

```bash
# Terminal 1
argus chrome start --url http://localhost:3000

# Terminal 2
argus watcher start --id app --url localhost:3000

# Terminal 3
argus logs tail app
```

Both `argus chrome start` and `argus watcher start` are also long-running commands.

## Chrome Extension

Use the extension when you want Argus against your normal Chrome session without launching Chrome with CDP flags.

### One-time setup

```bash
# Build the extension
cd packages/argus-extension
bun run build

# Load it in Chrome
# chrome://extensions -> Developer mode -> Load unpacked -> packages/argus-extension
# Copy the extension ID, then install the native host:
argus extension setup <EXTENSION_ID>
argus extension status
```

### Attach to a tab

1. Click the Argus extension icon in Chrome.
2. Click `Attach` on the tab you want to inspect.
3. Leave that tab open while debugging. Chrome's orange debugging bar is expected.

Then use the CLI as usual:

```bash
argus list
argus logs extension
argus eval extension-2 "document.title"
argus watcher start --id app --source extension
argus page ls --id app
```

### What changes in extension mode

- No special Chrome launch flags required
- Manual tab selection through the extension popup
- Each attached tab gets its own watcher id; use `argus list` to see them
- The popup can switch the active target between the top page and discovered iframes inside that tab
- `argus page ls --id <watcher>` shows only that watcher's page/iframe targets

### Limitations

- Chrome shows a debugging bar while attached; that cannot be hidden
- Only one debugger can attach to a tab at a time
- The target tab must stay open
- Cross-origin iframe eval needs the iframe helper script

## Reuse Auth State

If you already have an authenticated tab attached through the extension watcher, you can export that auth state and replay it either into a fresh isolated Chrome session or into another already-running watcher tab:

```bash
# Export cookies + storage from the attached tab
# Snapshot JSON also includes metadata such as export time, watcher id/source,
# page title/site domain, cookie count, auth-looking cookie names, and recommended URL.
argus auth export-state extension --out auth.json

# Launch a fresh temp Chrome profile and hydrate it
argus chrome start --auth-state auth.json

# Or hydrate an already attached watcher tab in place
argus auth load-state app --in auth.json

# Or stream the snapshot without writing a temp file
argus auth export-state extension | argus auth load-state app --in -

# Or clone directly between watchers
argus auth clone extension --to app

# Or launch a fresh Chrome+watcher session from another watcher's auth
argus start --id app --auth-from extension
```

Add `--url <url>` to override the final navigation target after hydration. By default Argus reopens the exported page URL. `--auth-state` always uses a fresh temp profile; combining it with copied Chrome profiles is intentionally rejected.

### Manage cookies

```bash
# Inspect exact cookie identity
argus auth cookies get app session --domain .example.com --path /

# Upsert a cookie via CDP
argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only

# Delete one cookie by identity
argus auth cookies delete app session --domain .example.com --path /

# Clear scoped slices of the cookie jar
argus auth cookies clear app --for-origin
argus auth cookies clear app --site --auth-only
argus auth cookies clear app --domain example.com --session-only
argus auth cookies clear app --browser-context
```

`auth cookies get` matches by `name + domain + path` so agents never have to guess across duplicate cookie names. `auth cookies clear` requires an explicit scope: the attached page host, the current site domain, an explicit domain suffix, or the whole browser context. `--session-only` and `--auth-only` narrow the deletion set before Argus calls Chrome's cookie-delete APIs.

## Common Workflows

### Debug console errors

```bash
argus logs app --levels error,warning --since 10m
argus logs tail app --levels error
```

### Watch network requests

```bash
argus net app --since 5m --grep api
argus net tail app --grep api
argus net watch app --reload --settle 3s
argus net inspect /api/post app --reload
argus net show 42 app
argus net body 42 app
argus net body 42 app --request
argus net export app --reload --settle 3s --out boot.har
```

`net watch` waits for a real quiet window instead of a fixed sleep, `net inspect` turns the common “clear + reload + settle + find match + dump bodies” loop into one command, `net show` drills into one buffered request and surfaces whether request/response bodies are fetchable, `net body` prints one buffered request or response body on demand, and `net export --format har` writes the current buffer or a fresh reload capture as a HAR file for sharing in other tools. Reload-driven `net watch` / `net export` / `net inspect` intentionally reject selected-frame scope.

### Inspect the DOM

```bash
argus dom tree app --selector "#root"
argus dom info app --testid "submit-btn"
argus snapshot app --interactive
argus locate role app button --name "Submit"
```

`snapshot` and `locate` emit stable watcher-local refs such as `e5`, which you can feed back into ref-aware commands like `click`, `fill`, `hover`, and `dom info`.

### Interact with the page

```bash
argus click app --selector "button.primary"
argus click app --ref e5
argus fill app --name email "vlad@example.com"
argus locate label app "Email" --action fill --value "vlad@example.com"
argus dom scroll app --by 0,300
argus dom wheel app --selector "input[type=number]" --by 0,-120
```

### Probe runtime state

```bash
argus eval app "document.title"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "window.__APP_STATE__" --json
argus eval-until app "document.querySelector('[data-ready]')"
```

### Work with iframes

```bash
argus eval app "document.location.href" --iframe "#payment-frame"
```

Cross-origin iframe eval works via postMessage helpers.

### Reverse-engineer runtime bundles

```bash
argus code ls app
argus code grep showLogsByHost --id app --pretty
argus code deminify http://127.0.0.1:3000/app.js --id app
argus code strings app --url app.js
argus code strings app --url app.js --kind url,identifier --match '/admin\\/api/'
```

### Capture evidence

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
argus trace app --duration 3s --out trace.json
```

## Core Concepts

### Chrome

Chromium with remote debugging enabled. Argus uses CDP (Chrome DevTools Protocol) to inspect and interact with targets.

### Watcher

A local process that attaches to a browser target, exposes an HTTP API, buffers events, and registers itself under an id such as `app`.

### Registry

Running watchers are announced through a local registry file so the CLI can resolve ids quickly.

## Architecture

Four packages:

- **`@vforsh/argus`**: CLI
- **`@vforsh/argus-watcher`**: watcher service that talks to CDP and exposes HTTP
- **`@vforsh/argus-client`**: programmatic Node.js client
- **`@vforsh/argus-core`**: shared protocol types and registry utilities

```text
            (CDP: WebSocket)
  ┌───────────────────────────────────┐
  │ Chromium (Chrome / Edge / etc.)   │
  │  - DOM / Network / Console / etc. │
  └───────────────┬───────────────────┘
                  │
                  ▼
  ┌───────────────────────────────────┐
  │ @vforsh/argus-watcher             │
  │  - connects to CDP                │
  │  - buffers/streams events         │
  │  - exposes HTTP API               │
  └───────────────┬───────────────────┘
                  │ announces presence
                  │ (local registry)
                  ▼
  ┌───────────────────────────────────┐       ┌───────────────────────────┐
  │ ~/.argus/registry.json            │◀──────│ @vforsh/argus (CLI) or    │
  │  - running watchers + endpoints   │◀──┐   │ @vforsh/argus-client      │
  └───────────────────────────────────┘   │   └───────────────┬───────────┘
                                          │                   │
                                          └───────────────────┤ fetches from watcher
                                                              │ (HTTP)
                                                              ▼
                                                     Your terminal / app output
```

## Command Surface

| Command                                                | Description                              |
| ------------------------------------------------------ | ---------------------------------------- |
| `start`                                                | Launch Chrome + watcher in one command   |
| `list`                                                 | List watchers and Chrome instances       |
| `doctor`                                               | Run environment diagnostics              |
| `reload`                                               | Reload the attached page                 |
| `chrome start\|ls\|version\|status\|stop`              | Chrome lifecycle management              |
| `watcher start\|stop\|status\|ls\|prune`               | Watcher lifecycle management             |
| `page ls\|open\|activate\|close\|reload`               | Tab and target management                |
| `logs` / `logs tail`                                   | Fetch or stream console logs             |
| `net` / `net tail`                                     | Fetch or stream network requests         |
| `eval`                                                 | Evaluate JS expression                   |
| `eval-until` / `wait`                                  | Poll JS expression until truthy          |
| `locate role\|text\|label`                             | Find semantic elements and return refs   |
| `code ls\|read\|grep\|deminify\|strings`               | Inspect and analyze runtime code         |
| `dom tree` / `dom info`                                | Inspect DOM                              |
| `click\|hover\|fill\|keydown\|scroll-to`               | Interact with elements                   |
| `dom focus\|scroll\|add\|add-script\|remove\|set-file` | DOM-focused actions and modifications    |
| `dom modify attr\|class\|style\|text\|html`            | Modify element properties                |
| `snapshot` / `ax`                                      | Accessibility tree snapshot              |
| `screenshot`                                           | Capture screenshot                       |
| `trace` / `trace start\|stop`                          | Chrome performance tracing               |
| `storage local\|session get\|set\|remove\|list\|clear` | Manage `localStorage` / `sessionStorage` |
| `config init`                                          | Create config file                       |
| `extension setup\|remove\|status\|info`                | Chrome extension native messaging        |

## Common Flags

- `--selector <css>`: target elements by CSS selector
- `--testid <id>`: shorthand for `--selector "[data-testid='<id>']"`
- `--ref <elementRef>`: target an element ref from `snapshot` / `locate` output
- `--text <string>`: filter by text content, supports `/regex/flags`
- `--name <attr>`: shorthand for `--selector "[name=<attr>]"`
- `--all`: allow multiple element matches
- `--json`: machine-readable output
- `--iframe <selector>`: evaluate inside an iframe

## Config

Argus can load defaults for `chrome start` and `watcher start` from repo-local config files.

- Auto-discovery order: `.argus/config.json`, `.config/argus.json`, `argus.config.json`, `argus/config.json`
- Use `--config <path>` to point at an explicit file
- CLI flags override config values
- `watcher.start.artifacts` is resolved relative to the config file directory

Example:

```json
{
	"$schema": "file:///.../node_modules/@vforsh/argus/schemas/argus.config.schema.json",
	"chrome": {
		"start": {
			"url": "http://localhost:3000",
			"profile": "default-lite",
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

## Plugins

Argus can load optional CLI plugins that register additional top-level commands.

- Config: add `"plugins": [...]` to an Argus config file
- Env: set `ARGUS_PLUGINS` to a comma-separated list of module specifiers or resolvable paths

Plugin modules must default-export:

```ts
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'

const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'my-plugin',
	register(ctx) {
		ctx.program.command('mycmd').action(() => {})
	},
}

export default plugin
```

TypeScript plugin authors should import from `@vforsh/argus-plugin-api`.

## Troubleshooting

### Watcher not found

```bash
argus list
argus doctor
argus watcher status app
```

If no watcher appears, make sure the long-running `argus start` or `argus watcher start` process is still alive.

### Chrome/CDP not reachable

```bash
argus chrome status
argus doctor
```

If needed, restart Chrome with `argus chrome start`.

### Registry contains stale entries

```bash
argus watcher prune
argus watcher prune --dry-run
```

### CLI changes are not visible during local development

```bash
npm run build:packages
```

### Extension mode behaves oddly

Check native host and extension status:

```bash
argus extension status
argus extension info
```

## Registry

Watchers register in `~/.argus/registry.json` on macOS/Linux or `%USERPROFILE%\\.argus\\registry.json` on Windows.

## Package Docs

- [packages/argus/README.md](./packages/argus/README.md): npm package entry
- [packages/argus-watcher/README.md](./packages/argus-watcher/README.md): watcher package
- [packages/argus-client/README.md](./packages/argus-client/README.md): Node client
- [packages/argus-core/README.md](./packages/argus-core/README.md): shared protocol/types

## Why "Argus"?

Named after **Argus Panoptes**, the all-seeing watcher of Greek mythology.
