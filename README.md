# Argus

Command-line Swiss Army knife for Chromium. Connects to one or more browser targets via CDP (Chrome DevTools Protocol) and provides an HTTP-based bridge for inspection, automation, and debugging from the terminal.

## Features

- **Logs & Console** — Fetch bounded history (`logs`) or stream live (`logs tail`). Filter by level, source, regex.
- **Network** — Query request summaries (`net`) or tail them live (`net tail`). Grep by URL.
- **DOM Inspection** — Tree view (`dom tree`), detailed element info (`dom info`), accessibility snapshots (`snapshot`).
- **DOM Interaction** — Click, hover, scroll, fill inputs, dispatch keyboard events. CSS selectors, `--testid`, `--text` regex filtering.
- **DOM Manipulation** — Add/remove elements, inject scripts, modify attributes/classes/styles/text/innerHTML, set files on `<input type="file">`.
- **Eval** — Execute JS expressions (`eval`) with async/await, retries, interval polling, cross-origin iframe support via postMessage.
- **Eval-Until** — Poll until truthy (`eval-until` / `wait`). Configurable interval, timeout, count.
- **Storage** — `localStorage` get/set/remove/list/clear for any origin.
- **Screenshots & Traces** — Element or full-page screenshots, Chrome performance traces with start/stop control.
- **Browser Control** — Launch Chrome with profiles (`chrome start`), manage tabs (`page open/close/activate/reload`), target tree view.
- **One-Command Start** — `argus start` launches Chrome + watcher in a single command.
- **Extension Support** — Chrome extension integration via native messaging host.
- **Config** — Auto-discovered config files (`.argus/config.json` etc.) for persistent defaults.
- **JSON Output** — `--json` flag on every command for programmatic use.

## Architecture

Four packages:

- **`@vforsh/argus`** — CLI. The primary interface.
- **`@vforsh/argus-watcher`** — Core service. Connects to CDP, buffers events, exposes HTTP API.
- **`@vforsh/argus-client`** — Programmatic Node.js client for building tools on top of Argus.
- **`@vforsh/argus-core`** — Shared protocol definitions and registry utilities.

```
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

## Quickstart

**Install & build:**

```bash
npm install
npm run build:packages
```

**Option A — One command (recommended):**

```bash
argus start --id app --url http://localhost:3000
```

Launches Chrome with CDP, attaches a watcher, registers it as `app`.

**Option B — Separate processes:**

```bash
# Terminal 1: launch Chrome
argus chrome start --url http://localhost:3000

# Terminal 2: attach watcher
argus watcher start --id app --url localhost:3000
```

**Use the CLI:**

```bash
# Discovery
argus list

# Logs & network
argus logs tail app
argus net tail app

# Eval
argus eval app "document.title"
argus eval-until app "document.querySelector('.loaded')"

# DOM inspection
argus dom tree app --selector "#root"
argus dom info app --testid "submit-btn"
argus snapshot app --interactive

# DOM interaction
argus dom click app --selector "button.primary"
argus dom fill app "hello" --name email
argus dom scroll app --by 0,500

# DOM manipulation
argus dom add app --selector "#root" --html "<div>injected</div>"
argus dom modify style app "color=red" --selector "h1"

# Storage
argus storage local list app

# Capture
argus screenshot app --out shot.png
argus trace app --duration 3s
```

## CLI Commands

| Command                                       | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `start`                                       | Launch Chrome + watcher in one command |
| `list`                                        | List watchers and Chrome instances     |
| `doctor`                                      | Run environment diagnostics            |
| `reload`                                      | Reload the attached page               |
| `chrome start\|ls\|version\|status\|stop`     | Chrome lifecycle management            |
| `watcher start\|stop\|status\|ls\|prune`      | Watcher lifecycle management           |
| `page ls\|open\|activate\|close\|reload`      | Tab/target management                  |
| `logs` / `logs tail`                          | Fetch or stream console logs           |
| `net` / `net tail`                            | Fetch or stream network requests       |
| `eval`                                        | Evaluate JS expression                 |
| `eval-until` / `wait`                         | Poll JS expression until truthy        |
| `dom tree`                                    | Fetch DOM subtree                      |
| `dom info`                                    | Detailed element info                  |
| `dom click\|hover\|scroll\|fill\|keydown`     | DOM interaction                        |
| `dom add\|add-script\|remove\|set-file`       | DOM manipulation                       |
| `dom modify attr\|class\|style\|text\|html`   | Element property modification          |
| `snapshot` / `ax`                             | Accessibility tree snapshot            |
| `screenshot`                                  | Capture screenshot                     |
| `trace` / `trace start\|stop`                 | Chrome performance tracing             |
| `storage local get\|set\|remove\|list\|clear` | localStorage management                |
| `config init`                                 | Create config file                     |
| `extension setup\|remove\|status\|info`       | Chrome extension native messaging      |

## Common Flags

- `--selector <css>` — Target elements by CSS selector.
- `--testid <id>` — Shorthand for `--selector "[data-testid='<id>']"`.
- `--text <string>` — Filter by textContent. Supports `/regex/flags`.
- `--name <attr>` — Shorthand for `--selector "[name=<attr>]"` (fill).
- `--all` — Allow multiple element matches.
- `--json` — Machine-readable JSON output.
- `--iframe <selector>` — Eval in cross-origin iframe via postMessage.

## Registry

Watchers register in `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are heartbeat-updated and pruned when stale.

## Why "Argus"?

Named after **Argus Panoptes**, the all-seeing watcher of Greek mythology.
