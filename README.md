# Argus

Brokerless console-log watcher for Chromium-based browsers via CDP. This repo is an npm workspaces monorepo with:

- `argus`: CLI
- `argus-watcher`: watcher library
- `argus-core`: shared types + registry helpers

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

4. Start a watcher from a Node script:

```bash
node scripts/start-watcher.mjs
```

5. Use the CLI:

```bash
node packages/argus/dist/bin.js list
node packages/argus/dist/bin.js logs app
node packages/argus/dist/bin.js tail app
```

## Registry

Watchers announce themselves in `~/.argus/registry.json` (macOS/Linux) or `%USERPROFILE%\.argus\registry.json` (Windows). Entries are updated periodically and pruned when stale or unreachable.
