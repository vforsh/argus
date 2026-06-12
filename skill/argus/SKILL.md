---
name: argus
description: Guides use of the Argus CLI to debug and inspect web apps via Chrome CDP or the Argus Chrome extension, including authenticated browser sessions, iframe targets, logs, eval, DOM, network, and screenshots.
---

## Argus CLI

Debug web apps through either:

- **Extension-control**: normal user Chrome profile, cookies, login state, existing extensions. Best for authenticated portal apps and ordinary browser sessions.
- **CDP Chrome**: Argus-launched/debuggable Chrome. Best for local apps, temp profiles, clean repros, headless runs, and raw Chrome target control.

Install/run:

```bash
npm i -g @vforsh/argus
argus --help
npx -y @vforsh/argus --help
```

**Long-running commands:** `argus start`, `argus chrome start`, `argus watcher start`, and log tails do not exit on their own. Start them in the background when using an agent shell.

---

## Pick The Mode

Use **extension-control** when the task needs the user's normal Chrome profile, saved login, cookies, local storage, or already-open tabs.

Use **CDP Chrome** when the task needs an isolated browser, headless run, custom CDP port, script injection at startup, or raw `chrome://`/target-id control.

Use **iframe target selection** when the app is embedded in a portal page and `eval`/DOM/click/screenshot must run inside the embedded app, not the host page.

Read:

- [START.md](./reference/START.md) for CDP startup, watcher lifecycle, config defaults, and Node API.
- [EXTENSION.md](./reference/EXTENSION.md) for extension setup and runtime limitations.
- [INSPECT.md](./reference/INSPECT.md) for command catalogs: logs, eval, screenshots, DOM, network, auth, storage, trace, pages, emulation.

---

## Authenticated Browser Profile Flow

Use this for any app that needs the user's normal browser profile, cookies, local storage, extensions, or saved login state. Do **not** use `argus start`, `argus chrome start --profile temp`, headless Chrome, or a fresh CDP profile for this flow; those lose the real login/session context.

```bash
APP_URL="https://portal.example/app"
WATCHER_ID="app"

open -a "Google Chrome" "$APP_URL"
argus ext doctor --json
argus ext tabs --url "$APP_URL" --json
argus ext use --url "$APP_URL" --as "$WATCHER_ID" --json
argus eval "$WATCHER_ID" "({ title: document.title, href: location.href })" --json
```

If multiple tabs match, do not guess. Run `argus ext tabs --url "$APP_URL" --json`, choose the intended `tabId`, then use:

```bash
argus ext use --tab <tabId> --as "$WATCHER_ID" --json
```

If the tab is restored in the background or app boot looks stuck, make it visible and reload:

```bash
argus ext show "$WATCHER_ID"
argus reload "$WATCHER_ID"
argus eval-until "$WATCHER_ID" "document.readyState === 'complete'" --total-timeout 30s
```

---

## Extension Iframe Flow

Use this when the real app lives in an iframe inside a host page.

```bash
APP_URL="https://portal.example/app"
WATCHER_ID="app"

open -a "Google Chrome" "$APP_URL"
argus ext use --url "$APP_URL" --as "$WATCHER_ID" --iframe-url game-frame-host.example --json
argus eval "$WATCHER_ID" "({ title: document.title, origin: location.origin })" --json
```

If iframe selection fails because the iframe is not present yet:

```bash
argus ext use --url "$APP_URL" --as "$WATCHER_ID" --json
argus ext show "$WATCHER_ID"
argus reload "$WATCHER_ID"
argus eval-until "$WATCHER_ID" "document.querySelectorAll('iframe').length > 0" --total-timeout 30s
argus ext targets "$WATCHER_ID" --tree
argus ext select "$WATCHER_ID" --iframe-url game-frame-host.example --json
```

Useful selectors:

```bash
argus ext select "$WATCHER_ID" --iframe-url game-frame-host.example
argus ext select "$WATCHER_ID" --iframe-title "Game Title"
argus ext select "$WATCHER_ID" --iframe auto
argus ext select "$WATCHER_ID" --page
argus ext doctor --watcher "$WATCHER_ID"
```

`--iframe auto` is a convenience heuristic and should fail closed when multiple iframes look equally plausible. Prefer `--iframe-url` or `--iframe-title` when correctness matters.

---

## Inspect Loop

Once a watcher is attached, use quick bounded commands first:

```bash
argus logs app --since 10m --levels error,warning
argus eval app "({ href: location.href, title: document.title })" --json
argus screenshot app --out shot.png
argus dom tree app --selector body --depth 2
argus snapshot app --interactive
```

For interaction:

```bash
argus locate role app button --name "Submit"
argus click app --selector "button.submit"
argus click app --ref e5
argus fill app --selector "#email" "user@example.com"
argus keydown app --key Enter
argus scroll-to app --selector "#footer"
```

For iframe-active extension watchers, commands run against the selected iframe target. Screenshots, selectors, and eval are resolved relative to that iframe.

For deeper command lists, use [INSPECT.md](./reference/INSPECT.md). For eval flags, polling, file scripts, and args, use [EVAL.md](./reference/EVAL.md).

---

## CDP Quick Start

Use CDP for local apps and clean repros where a temp/debuggable browser is acceptable.

```bash
npm run dev
argus start --id app --url localhost:3000
argus eval app "location.href"
argus screenshot app --out shot.png
```

`argus start` launches Chrome and a watcher together. For more control:

```bash
argus chrome start --url http://localhost:3000
argus watcher start --id app --url localhost:3000 --chrome-port 9222
```

Keep these commands in the background in agent shells. See [START.md](./reference/START.md) for profile modes, auth-state hydration, watcher target flags, config defaults, and programmatic watcher APIs.

---

## Troubleshooting

**No extension-control watcher** — Open/reload the browser extension, then run `argus ext doctor --json`.

**Multiple tabs matched** — Use `argus ext tabs --url <url> --json`, choose a `tabId`, then pass `--tab <tabId>`.

**Iframe not found** — `argus ext show <id>`, `argus reload <id>`, wait for iframes, then `argus ext targets <id> --tree`.

**Eval runs on host page** — Select the iframe first: `argus ext select <id> --iframe-url <substring>`.

**Watcher cannot attach in CDP mode** — Check the Chrome port: `argus chrome status --cdp 127.0.0.1:9222`.

**Wrong CDP target matched** — Use `--type iframe`, `--origin`, `--parent`, or `--target`. See [IFRAMES.md](./reference/IFRAMES.md).

**Need to keep a page unthrottled** — Use `argus page show <id>` or `argus ext show <id>`. Hide later with `argus page hide <id>`.

---

## References

- [START.md](./reference/START.md) — CDP startup, watcher lifecycle, config defaults, Node API.
- [EXTENSION.md](./reference/EXTENSION.md) — Extension setup and extension-control details.
- [INSPECT.md](./reference/INSPECT.md) — Logs, screenshots, DOM, interaction, network, auth, storage, trace, emulation.
- [EVAL.md](./reference/EVAL.md) — Eval syntax, polling, files, args, iframe eval.
- [RUNTIME_CODE.md](./reference/RUNTIME_CODE.md) — Runtime JS/CSS discovery and live CSS edits.
- [IFRAMES.md](./reference/IFRAMES.md) — CDP iframe targeting and iframe concepts.
- [EXTENSION_IFRAME_EVAL.md](./reference/EXTENSION_IFRAME_EVAL.md) — Cross-origin iframe helper mechanics.
- [INJECT.md](./reference/INJECT.md) — Script injection on watcher attach/navigation.
- [DIALOG.md](./reference/DIALOG.md) — Browser dialog status and handling.
- [PLUGINS.md](./reference/PLUGINS.md) — CLI plugin loading and Google Sheets plugin.
