# Argus

A developer’s command-line Swiss Army knife for Chromium.

Argus connects to one or more Chromium targets via CDP (Chrome DevTools Protocol) and provides a powerful HTTP-based bridge for remote inspection, automation, and debugging directly from your terminal.

## Features

- **Logs & Console**: Fetch bounded log history (`logs`) or stream them in real-time (`tail`).
- **Network Monitoring**: Query recent network request summaries (`net`) or follow them live (`net tail`).
- **DOM & HTML**: Inspect the DOM tree (`dom tree`) or get detailed element information (`dom info`) via CSS selectors.
- **Remote Evaluation**: Execute JavaScript expressions (`eval`) with support for awaiting promises, retries, and interval-based polling.
- **Storage Management**: Interact with `localStorage` (`storage local`) to get, set, list, or clear items for any origin.
- **Artifacts & Debugging**: Capture performance traces (`trace`) or element-specific screenshots (`screenshot`) to disk.
- **Browser Control**: Launch Chrome with custom profiles (`chrome start`) and manage tabs (`page open`, `reload`, `close`).

## Architecture

Argus consists of four main packages:

- **`@vforsh/argus` (CLI)**: The primary tool for interacting with watchers.
- **`@vforsh/argus-watcher`**: The core service that connects to CDP, buffers events, and exposes a rich HTTP API.
- **`@vforsh/argus-client`**: A programmatic Node.js client for building your own tools on top of Argus.
- **`@vforsh/argus-core`**: Shared protocol definitions and registry utilities.

Diagram (data flow):

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

1. **Install dependencies & build**:

```bash
npm install
npm run build:packages
```

2. **Launch Chrome with CDP enabled**:

```bash
argus chrome start --url http://localhost:3000
```

3. **Start a watcher** (in a separate terminal):

```bash
argus watcher start --id app --url localhost:3000
```

This watcher will capture events from any page matching the URL pattern and announce itself in the local registry.

4. **Use the CLI**:

```bash
# Discovery
argus list

# Logs & Network
argus tail app
argus net tail app

# Interaction & Inspection
argus eval app "document.title"
argus dom tree app --selector "#root"
argus storage local list app

# Artifacts
argus screenshot app --out shot.png
```

## Registry

Watchers announce themselves in `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are updated periodically and pruned when stale or unreachable.

## Why “Argus”?

“Argus” is a nod to **Argus Panoptes** (the many‑eyed, all‑seeing watcher in Greek mythology). This project “keeps an eye” on Chromium targets and streams what it sees to your preferred environment.
