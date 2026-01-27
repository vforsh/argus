# CDP workflow (recommended)

Use this when you can launch Chrome with CDP enabled via `argus chrome start`, and want automatic target selection via `--url` matching.

## Contents

- Start your app
- Start Chrome (CDP)
- Start the watcher (CDP mode)
- Operate via CLI (logs/eval/screenshot)
- Notes and tips

## Start your app

Start your dev server the normal way and capture its URL.

```bash
npm run dev
export APP_URL="http://localhost:3000"
```

## Start Chrome (CDP)

```bash
argus chrome start --url "$APP_URL"
```

Notes:

- **Port behavior**: uses **9222** if available; otherwise picks a free ephemeral port and prints it.
- **Lifecycle**: stays alive until Ctrl+C; cleans up the temp profile on exit.

Useful variants:

```bash
argus chrome start --dev-tools
argus chrome start --profile default-full
argus chrome start --json
argus chrome start --from-watcher app
```

## Start the watcher (CDP mode)

Use the CDP port Chrome printed (commonly `9222`).

```bash
argus watcher start --id app --url "$APP_URL" --chrome-port 9222
```

Notes:

- **`--id`**: the name you’ll use for `logs`, `eval`, `screenshot`, etc.
- **`--url`**: a URL/pattern used to decide which targets to attach to.
- **Indicator**: enabled by default; disable with `--no-page-indicator`.

## Operate via CLI

```bash
argus logs app --since 10m --levels error,warning
argus tail app
argus eval app "location.href"
argus screenshot app --out shot.png
```

If you need `targetId` for page-level commands:

```bash
argus page targets --id app
argus page reload <targetId> --id app
```

## Notes and tips

- **Config defaults**: See `CONFIG.md` in this folder.
- **Iframes**: If you’re attaching to an embedded app, see `IFRAMES.md` for `--type iframe`, `--origin`, `--target`, `--parent`.
