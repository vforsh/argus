## Inspect Commands

Use this as the command catalog after a watcher is attached. For eval-specific flags, polling, file scripts, and args, see [EVAL.md](./EVAL.md). For network capture, filtering, bodies, export, and mocks, see [NET.md](./NET.md).

## Logs

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Error|Exception" --ignore-case
argus logs app --source console
argus logs app --json
argus logs app --json-full
argus logs tail app
argus logs tail app --levels error --json
```

## Eval / Wait

```bash
argus js app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "document.title" --json
argus eval app "window.store.getState()" --inject ./debug-hooks.js
argus eval-until app "document.querySelector('#loaded')"
argus eval-until app "window.APP_READY" --interval 500 --total-timeout 30s
argus wait app --file ./ready.js --arg level=10 --total-timeout 20s
```

`js` is the short alias for `eval`; `wait` is the short alias for `eval-until`.

## Screenshots

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
argus screenshot app --clip 100,80,640,360 --out crop.png
```

When the active extension target is an iframe, screenshots and selector clips are resolved relative to that iframe.

## DOM / Snapshot / Locate

```bash
argus dom tree app --selector "body"
argus dom tree app --testid "main-content"
argus dom tree app --selector "div" --all --depth 3
argus dom info app --selector "#root"
argus dom info app --ref e3
argus snapshot app
argus snapshot app --interactive
argus snapshot app --selector "form" --depth 3
argus locate role app button --name "Submit"
argus locate text app "Continue"
argus locate label app "Email" --action fill --value "me@example.com"
```

`--testid <id>` is shorthand for `--selector "[data-testid='<id>']"`. `snapshot` and `locate` emit stable watcher-local refs such as `e5`, which ref-aware commands can reuse.

## Interaction

```bash
argus click app --selector "button.submit"
argus click app --testid "submit-btn"
argus click app --ref e5
argus click app --selector ".delayed-btn" --wait 5s
argus click app --pos 100,200
argus hover app --selector ".menu-item"
argus fill app --selector "#username" "Bob"
argus fill app --selector "#desc" --value-file ./description.txt
echo "hello" | argus fill app --selector "#input" --value-stdin
argus keydown app --key Enter
argus keydown app --key a --selector "#input"
argus keydown app --key a --modifiers shift,ctrl
argus scroll-to app --selector "#footer"
argus scroll-to app --to 0,1000
argus scroll-to app --selector ".panel" --by 0,500
```

`--wait <duration>` on click/fill polls for the selector before acting. Duration examples: `5s`, `500ms`, `2m`.

## Dialogs

```bash
argus dialog status app
argus dialog accept app
argus dialog dismiss app
argus dialog prompt app --text "updated value"
argus dialog status app --json
```

Browser JavaScript dialogs include `alert`, `confirm`, `prompt`, and `beforeunload`.

## DOM Helpers

```bash
argus dom focus app --selector "#input"
argus dom focus app --testid "search-box"
argus dom focus app --ref e5
argus dom set-file app --selector "input[type=file]" --file ./build.zip
argus dom upload app --selector "input[type=file]" --file ~/Downloads/test.zip
argus dom scroll app --by 0,300
argus dom wheel app --selector "input[type=number]" --by 0,-120
argus dom scroll app --selector ".panel" --by 0,200
argus dom scroll app --pos 400,300 --by 0,200
```

`dom scroll` dispatches real wheel input via CDP. `dom set-file` / `dom upload` set file inputs.

## Storage

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

## Auth

```bash
argus auth cookies list app
argus auth cookies list app --show-values --json
argus auth cookies ls app --for-origin --exclude-tracking
argus auth cookies get app session --domain .example.com --path /
argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only
argus auth cookies delete app session --domain .example.com --path /
argus auth cookies clear app --for-origin
argus auth cookies clear app --site --auth-only
argus auth export-cookies app --format netscape
argus auth export-state app --out auth.json
argus auth load-state app --in auth.json
argus auth clone extension-2 --to app
argus chrome start --auth-state auth.json
argus start --id app --auth-from extension-2
```

`auth export-state` writes cookies, `localStorage`, `sessionStorage`, and metadata. `auth load-state` rehydrates into the current watcher tab. `auth clone` copies auth state directly between watchers.

## Trace

```bash
argus trace app --duration 3s --out trace.json
argus trace start app --categories "devtools.timeline"
argus trace stop app --out trace.json
```

## Emulation / Visibility / Throttle

```bash
argus page emulation set app --device iphone-14
argus page emulation set app --width 1600 --height 900
argus page emulation clear app
argus page emulation status app --json
argus page show app
argus ext show --url localhost
argus page hide app
argus throttle set app 4
argus throttle clear app
argus throttle status app
```

`page show` / `ext show` keeps a page shown and focused so timers and `requestAnimationFrame` do not throttle while debugging.
