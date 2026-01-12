# Argus

Console-log watcher for Chromium-based browsers via CDP. This repo is an npm workspaces monorepo with:

- `@vforsh/argus`: CLI
- `@vforsh/argus-client`: programmatic Node.js client
- `@vforsh/argus-watcher`: watcher library
- `@vforsh/argus-core`: shared types + registry helpers

## What it does (high-level)

Argus **connects to one or more Chromium targets via CDP**, subscribes to runtime/console events, and **streams logs to your terminal**. Each watcher connects directly to Chrome and advertises itself locally so it can be discovered.

- **`@vforsh/argus` (CLI)**: CLI tool for interacting with watchers (`list`, `logs`, `tail`).
- **`@vforsh/argus-client`**: Programmatic Node.js client for discovering watchers and fetching logs.
- **`@vforsh/argus-watcher`**: Programmatic watcher. Connects to Chrome (CDP), collects console output, and exposes them over a HTTP surface.
- **`@vforsh/argus-core`**: Shared protocol/types + registry utilities used across the project.

Diagram (data flow):

```
            (CDP: WebSocket)
  ┌───────────────────────────────────┐
  │ Chromium (Chrome / Edge / etc.)   │
  │  - console.log / errors / events  │
  └───────────────┬───────────────────┘
                  │
                  ▼
  ┌───────────────────────────────────┐
  │ @vforsh/argus-watcher             │
  │  - connects to CDP                │
  │  - buffers/streams log events     │
  │  - serves logs over HTTP          │
  └───────────────┬───────────────────┘
                  │ announces presence
                  │ (local registry)
                  ▼
  ┌───────────────────────────────────┐       ┌───────────────────────────┐
  │ ~/.argus/registry.json            │◀──────│ @vforsh/argus (CLI)       │
  │  - running watchers + endpoints   │◀──┐   │ OR @vforsh/argus-client   │
  └───────────────────────────────────┘   │   └───────────────┬───────────┘
                                          │                   │
                                          └───────────────────┤ fetches from watcher
                                                              │ (HTTP)
                                                              ▼
                                                     Your terminal / app output
```

## Why “Argus”?

“Argus” is a nod to **Argus Panoptes** (the many‑eyed, all‑seeing watcher in Greek mythology). This project “keeps an eye” on Chromium targets via CDP and streams what it sees (console logs, errors, etc.).

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Build packages:

```bash
npm run build:packages
```

3. Start Chrome with CDP enabled:

```bash
node packages/argus/dist/bin.js chrome start --url http://localhost:3000
```

This launches Chrome with a fresh temp profile and CDP on port 9222 (or an available port if 9222 is in use). The command runs until you press Ctrl+C.

4. Start a watcher (in a separate terminal):

```bash
node packages/argus/dist/bin.js watcher start --id app --url localhost:3000
```

This starts a watcher that captures logs from pages matching the URL pattern.

5. Use the CLI (in another terminal):

```bash
node packages/argus/dist/bin.js list
node packages/argus/dist/bin.js logs app
node packages/argus/dist/bin.js tail app
```

### Alternative: Manual Chrome launch

If you prefer to launch Chrome manually:

macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Linux:

```bash
google-chrome --remote-debugging-port=9222
```

Windows (PowerShell):

```powershell
& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222
```

## Registry

Watchers announce themselves in `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are updated periodically and pruned when stale or unreachable.

## Troubleshooting

- **`TS2307: Cannot find module '@vforsh/argus-core'` (or similar workspace package imports)**: your npm workspaces may not be linked into `node_modules` (no publish required).

```bash
npm install --no-audit --no-fund --prefer-offline
npm ls @vforsh/argus-core --all
npm run build
```

- **Seeing `Object` instead of expanded objects in logs**: this is a CDP quirk. `Runtime.consoleAPICalled` sometimes omits `value`/`preview` for object arguments, so the watcher may fall back to a generic `Object` string. This tends to happen with “non-trivial” objects (e.g. class instances, Proxies, large/complex objects, some platform objects like IDB/DOM-related handles), and can vary across Chrome versions. Even when objects are expanded, values are often shallow previews (nested objects may still appear as `Object`).
