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
argus logs cursor app --json
argus logs epoch app
argus logs tail app
argus logs tail app --levels error --json
```

`logs cursor` / `logs epoch` return the current opaque watcher-session cursor without downloading the buffer. Save it before an action, then pass it to `logs --after <cursor>` or `logs --since-epoch <cursor>` to read only newly produced events. Cursors survive page reloads but fail explicitly after watcher restart, foreign-session use, or ring-buffer eviction.

Verification runner pattern:

```bash
epoch=$(argus logs cursor app)
# perform the action
argus logs app --after "$epoch" --levels error,exception --json
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

## Screenshots / Recording

```bash
argus screenshot app --out shot.png
argus screenshot app --selector "canvas" --out canvas.png
argus record app --duration 5s --out demo.mp4
argus record app --duration 3s --selector "canvas" --out canvas.mp4
```

See [CAPTURE.md](./CAPTURE.md) for crop semantics, iframe behavior, recording start/stop, `ffmpeg`, and troubleshooting.

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

## Navigation

```bash
argus page url app
argus page url app --json
argus goto app http://localhost:3000/checkout
argus goto app localhost:3000
argus goto app /settings
argus goto app "?tab=2"
argus goto app "#pricing"
argus goto app --param debug=1 --param locale=fr
argus goto app --params "a=1&b=2"
argus goto app /slow --wait domcontentloaded
argus goto app /slow --wait none
argus goto app /settings --timeout 5s --json
argus page back app
argus page forward app
argus page back app -n 2
argus page goto app /settings   # `goto` is the top-level alias for this
argus page nav app /settings    # `nav` is the subcommand alias
```

**URL forms.** Resolution happens in the watcher, which owns the page's authoritative URL:

| Input                                        | Result                           |
| -------------------------------------------- | -------------------------------- |
| `https://x/y`, `about:blank`                 | used verbatim                    |
| `localhost:3000`, `example.com/x`            | prefixed with `http://`          |
| `/settings`, `?tab=2`, `#top`, `./x`, `../x` | resolved against the current URL |

A bare token with no leading `/`, `?`, `#`, or `.` is treated as a host, not a path: `argus goto app settings` navigates to `http://settings/`. Write `/settings`.

**Query rewriting.** `--param key=value` (repeatable) and `--params "a=b&c=d"` overwrite the named keys and leave the rest of the query intact. Omit the positional URL to rewrite the current URL in place: `argus goto app --param debug=1`. `--params` is applied first, so a `--param` naming the same key wins.

**Wait modes.** `--wait load` (default) waits for the `load` event; `--wait domcontentloaded` returns once the DOM is parsed, before subresources; `--wait none` returns as soon as Chrome accepts the command and reports the requested URL rather than an observed one. There is no `networkidle`. `--timeout <duration>` (default 30s) bounds the wait only, and only a `load`/`domcontentloaded` event that arrives _after_ the top-frame navigation counts — a stale event from the previous document cannot settle it. A navigation that fires no load event settles immediately rather than burning the budget: a same-document one (hash change, `pushState`) and a back/forward-cache restore, where the document is resumed rather than parsed.

**Epochs.** Every `goto`/`back`/`forward` opens a log epoch just before dispatch and returns it, so the new page's logs can be read without racing them:

```bash
EPOCH=$(argus goto app /checkout --json | jq -r .epoch)
argus logs app --since-epoch "$EPOCH"
```

**History.** `back`/`forward` take `-n, --steps <n>` (default 1) and report `index`/`length` for the resulting position. Stepping outside the history fails with `no_history` rather than doing nothing.

**Scope.** Navigation is page-scoped like `reload`, even when an iframe target is selected: the iframe stays selected and the usual `extension_frame_not_ready` recovery applies after the load. Both source modes go through CDP, so extension-mode watchers behave identically.

**Errors.** `navigation_failed` carries Chrome's own `errorText` (`net::ERR_NAME_NOT_RESOLVED`). `navigation_timeout` means the phase did not arrive in time — the page may still be loading.

## Interaction

```bash
argus click app --selector "button.submit"
argus click app --testid "submit-btn"
argus click app --ref e5
argus click app --selector ".delayed-btn" --wait 5s
argus click app --pos 100,200
argus drag app --selector "#piece" --by 120,0
argus drag app --selector "canvas" --pos 320,240 --by 80,-30
argus drag app --pos 200,300 --to 500,300
argus hover app --selector ".menu-item"
argus fill app --selector "#username" "Bob"
argus fill app --selector "#desc" --value-file ./description.txt
echo "hello" | argus fill app --selector "#input" --value-stdin
argus keydown app --key Enter
argus keydown app --key G
argus keydown app --code KeyG --print-event
argus keydown app --code Backquote
argus keydown app --code Backquote --shift
argus keydown app --key a --selector "#input"
argus keydown app --key a --shift --ctrl
argus scroll-to app --selector "#footer"
argus scroll-to app --to 0,1000
argus scroll-to app --selector ".panel" --by 0,500
argus click app --selector "a.next" --wait-nav
argus click app --selector "a.next" --wait-nav domcontentloaded --nav-timeout 5s
argus keydown app --key Enter --selector "#search" --wait-nav
```

`drag` uses real Chrome mouse input (`mousePressed` → `mouseMoved` → `mouseReleased`), which works for canvas/WebGL game interactions. With `--selector`/`--ref`, `--pos` is an offset from the element top-left; without an element target, `--pos` is the viewport start.

`keydown` accepts `--key` (a `KeyboardEvent.key` value) and/or `--code` (a `KeyboardEvent.code` value); both are case-insensitive. Recognized codes: `KeyA`–`KeyZ`, `Digit0`–`Digit9`, `F1`–`F12`, `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, the arrows, `Home`/`End`/`PageUp`/`PageDown`/`Insert`, and the US-layout punctuation row (`Backquote`, `Minus`, `Equal`, `BracketLeft`, `BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Comma`, `Period`, `Slash`). With `--shift`, punctuation and digits resolve to their shifted character while keeping the physical code — `--code Backquote --shift` dispatches `key: ~`, `code: Backquote`, `keyCode: 192`.

`keydown` sends one `keyDown` and one `keyUp` — the same two events Chrome's other automation clients send. Keys that produce text (letters, digits, punctuation, `Space`, and `Enter`) carry it on the `keyDown`, so the page sees exactly what a real press produces: one `keydown`, one `keypress`, one `input`. `--key Enter` therefore submits a focused form and inserts a newline in a textarea. Keys that produce no text (`Tab`, `Escape`, `Backspace`, the arrows, F-keys) go out as `rawKeyDown` and fire no `keypress` — also what a real press does.

`keydown` does not set `nativeVirtualKeyCode`; that field means the _platform's_ key code (a Carbon keycode on macOS), and sending the Windows value there made Chrome 152 headless repeat the key thousands of times a second until the renderer stopped answering CDP.

Chrome delivers keyboard input only to a focused page, and acks the CDP command either way — so `keydown` proves focus before dispatching. A hidden page (headless, background tab, covered window) is activated first, using the same sticky lock as `argus page show`, and the response says `activated: true`; `argus page hide <id>` releases it. When activation does not take, the command fails with `target_not_focused` rather than reporting a key the page never received. Visible pages are untouched: `activated` stays `false` and nothing extra is sent.

`--wait <duration>` on click/fill/drag polls for the selector before acting. Duration examples: `5s`, `500ms`, `2m`.

`--wait-nav [mode]` on `click`/`keydown` waits for a top-frame navigation the interaction caused; a bare flag means `load`, and it accepts the same modes as `goto`. The response gains `navigation: { navigated, url, epoch }`. Not navigating is a success, not an error: a click on a plain button answers `navigated: false` once `--nav-timeout <duration>` (default 10s) elapses, and human output says `(no navigation)`. Only the top frame counts — an iframe that navigates internally also reports `navigated: false`. The `epoch` is opened before the interaction, so `argus logs <id> --since-epoch <epoch>` reads exactly what followed it.

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

## Opening a Tab With a Watcher

```bash
argus page open --url http://localhost:3000 --attach --as app
```

CDP mode only. Opens the tab, then attaches a watcher matched by that tab's **target id** — never by URL, so a second tab showing the same page cannot be picked instead. `--as <watcherId>` is required with `--attach`. The command owns the watcher, so it stays in the foreground until Ctrl+C; run it in the background in agent shells, exactly like `argus start`. `--no-page-indicator` and `--artifacts <dir>` apply to the attached watcher. Without `--attach`, `page open` just prints the new target and exits.
