---
name: argus
description: Guides use of the Argus CLI to debug local web apps via Chrome CDP or the Argus Chrome extension (start Chrome/watcher, select targets including iframes, tail logs, eval JavaScript, and capture screenshots).
---

## Argus CLI (CDP + watcher workflows)

Argus connects to a running watcher and gives you fast, scriptable access to:

- **Logs**: `argus logs`, `argus tail`
- **Eval**: `argus eval` (full docs: [EVAL.md](./reference/EVAL.md))
- **Screenshots**: `argus screenshot`
- **Targets/pages**: `argus page targets|open|reload`

Keep long-running processes (dev server, Chrome, watcher) in separate terminals.

## Quick start (recommended: CDP mode)

```bash
# 0) Start your app (project-specific)
npm run dev
export APP_URL="http://localhost:3000"

# 1) Start Chrome with CDP enabled (prints host/port)
argus chrome start --url "$APP_URL"

# 2) Start a watcher against that Chrome instance
argus watcher start --id app --url "$APP_URL" --chrome-port 9222

# 3) Use the CLI against the watcher
argus logs app --since 10m --levels error,warning
argus eval app "document.title"
argus screenshot app --out shot.png
```

More details: [WORKFLOW_CDP.md](./reference/WORKFLOW_CDP.md)

## Quick start (extension mode)

Use extension mode when you can’t (or don’t want to) start Chrome with `--remote-debugging-port`.

```bash
# one-time setup (build extension, load unpacked, install native host)
argus extension setup <EXTENSION_ID>

# after attaching via the extension popup:
argus list
argus logs extension
argus eval extension "location.href"
```

More details: [WORKFLOW_EXTENSION.md](./reference/WORKFLOW_EXTENSION.md)

## Iframes and target selection

If your app runs inside an iframe (embedded games/widgets), use explicit targeting so you attach to the right target:

- CDP mode: `argus watcher start --type iframe`, `--origin`, `--target`, `--parent`
- Extension mode cross-origin iframe eval: requires a helper script (see [EXTENSION_IFRAME_EVAL.md](./reference/EXTENSION_IFRAME_EVAL.md))

Details: [IFRAMES.md](./reference/IFRAMES.md)

## Config defaults (optional)

Argus can load defaults from a repo-local config file (CLI flags still win).

Details + example config: [CONFIG.md](./reference/CONFIG.md)

## Reference (read this when needed)

- **CDP workflow**: [WORKFLOW_CDP.md](./WORKFLOW_CDP.md)
- **Extension workflow**: [WORKFLOW_EXTENSION.md](./reference/WORKFLOW_EXTENSION.md)
- **Common commands**: [COMMANDS.md](./reference/COMMANDS.md)
- **Iframes/targets**: [IFRAMES.md](./reference/IFRAMES.md)
- **Troubleshooting**: [TROUBLESHOOTING.md](./reference/TROUBLESHOOTING.md)
- **Programmatic watcher API**: [PROGRAMMATIC.md](./reference/PROGRAMMATIC.md)
