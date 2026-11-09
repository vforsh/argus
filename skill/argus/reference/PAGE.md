# Page: Navigation, Visibility, Emulation, Throttle, Dialogs

## Navigation

```bash
argus page url app                        # bare URL, pipe-friendly; --json
argus goto app https://x/checkout         # alias of `page goto`; also `nav`
argus goto app localhost:3000             # scheme-less → http://
argus goto app /settings                  # relative to current URL; also ?tab=2, #top, ./x, ../x
argus goto app --param debug=1 --param locale=fr    # rewrite query of the current URL in place
argus goto app /x --params "a=1&b=2" --param a=9    # --params first, --param wins
argus goto app /slow --wait domcontentloaded        # load (default) | domcontentloaded | none
argus goto app /settings --timeout 5s --json
argus page back app / forward app         # -n, --steps <n>; same --wait/--timeout
argus reload app [--ignore-cache]         # alias of `page reload --id app` / `watcher reload`
argus reload app --timeout 2m --until "appctl.ready()" --until-timeout 60s   # reload budget (default 60s), then a separate wait budget; never matches the pre-reload page
argus page reload <targetId> --param foo=bar        # reload any CDP target, optionally rewriting query
```

- A bare token without `/`, `?`, `#`, or `.` is a **host**: `goto app settings` → `http://settings/`. Write `/settings`.
- Every `goto`/`back`/`forward` returns `epoch` in `--json` for race-free log reads ([LOGS.md](./LOGS.md)).
- `--wait none` returns as soon as Chrome accepts the command and reports the requested URL. There is no `networkidle`; use `net watch --settle` ([NET.md](./NET.md)). Same-document navigations and bfcache restores settle immediately.
- Navigation is tab-scoped even with an iframe selected; the selection persists and `extension_frame_missing`/`extension_frame_not_ready` recovery applies.
- Errors: `navigation_failed` carries Chrome's `errorText` (`net::ERR_CONNECTION_REFUSED`); `navigation_timeout` means the phase was late, not that it failed; `no_history` means already at the edge (`index`/`length` in the response).

## Targets (CDP only)

```bash
argus page ls --tree                      # alias: page targets; --type page|iframe|worker; --id app or --cdp host:port
argus page open --url http://localhost:3000            # opens a tab, prints target id
argus page open --url http://localhost:3000 --attach --as app   # + watcher, foreground (see START.md)
argus page activate <targetId> | --url localhost:3000 | --title Docs | --match Argus
argus page close <targetId>
```

## Visibility Lock

Chrome throttles timers/rAF on hidden tabs. The lock forces the page to behave as shown+focused.

```bash
argus page visibility app --json          # read-only: { state: shown|default, policy: foreground|background, attached }
argus page show app                       # lock shown; may activate the tab/window
argus page show app --policy background   # keep running without stealing OS focus
argus page show app --policy foreground --no-activate
argus page hide app                       # release lock; --policy retains a policy, --no-activate for cleanup
argus watcher show app / hide app         # aliases
argus ext show app | --url … | --tab …    # extension: attach if needed, then lock
```

- State + policy live in the running watcher: survive reattach and reloads, not watcher/browser restarts. An explicit extension detach disposes the watcher; re-apply after a new attach.
- Under `background`, `screenshot`/`record` return `not_available` (also on headless). Stop recordings before switching to background. Use `--policy foreground` or an isolated headless CDP watcher when capture matters.
- `keydown` applies the same lock automatically on hidden pages ([INTERACT.md](./INTERACT.md#keyboard)).
- Older watchers that cannot report policy are rejected before mutation: restart them on the current build.
- Snapshot/restore for automation: save `page visibility --json`, change, then restore with `page show`/`page hide` + `--no-activate`. Not atomic; single owner only.

## Emulation

```bash
argus page emulation set app --device iphone-14       # alias: page emu
argus page emulation set app --width 1600 --height 900 --dpr 2
argus page emulation set app --device pixel-7 --width 500 --touch --mobile --ua "Custom UA"
argus page emulation status app --json
argus page emulation clear app
```

Devices: `iphone-14`, `iphone-15-pro-max`, `pixel-7`, `ipad-mini`, `desktop-1440`, `desktop-1600`. `--no-mobile` / `--no-touch` disable those toggles.

## CPU & Network Throttle

```bash
argus throttle set app 4        # CPU: 4× slowdown; 1 = none
argus throttle clear app        # CPU only
argus throttle status app       # CPU and network; --json adds a `network` block

argus throttle net set app --preset slow-4g                    # fast-4g | slow-4g | 3g | offline
argus throttle net set app --latency 300 --down 1500 --up 750  # ms, kbps, kbps; an omitted cap is unlimited
argus throttle net set app --preset 3g --latency 500           # preset with one value overridden
argus throttle net clear app
```

| Preset    | Latency  | Down      | Up        |
| --------- | -------- | --------- | --------- |
| `fast-4g` | 165 ms   | 8100 kbps | 1350 kbps |
| `slow-4g` | 562.5 ms | 1440 kbps | 675 kbps  |
| `3g`      | 2000 ms  | 400 kbps  | 400 kbps  |
| `offline` | —        | —         | —         |

`offline` fails every request and flips `navigator.onLine` to `false`.

- **Sticky**: both throttles are owned by the watcher and hold until cleared, across `eval`, `reload`, navigation, and detach/re-attach. Set while detached, they are queued and applied on attach. They end with the watcher.
- **Set replaces**: each `throttle net set` states the full conditions; nothing carries over from the previous set.
- **Cold loads**: pair with `argus net cache clear app` ([NET.md](./NET.md)); a throttled load served from cache measures nothing.
- **Scope**: the network throttle covers the page target. Out-of-process iframes and workers keep their normal network; a CDP watcher attached directly to an iframe (`--type iframe`) throttles that iframe.

## Dialogs

Chrome exposes one active JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) at a time; while open, most CDP calls fail with `dialog_blocking`.

```bash
argus dialog status app --json            # active dialog or null
argus dialog accept app                   # OK / Leave
argus dialog dismiss app                  # Cancel / Stay
argus dialog prompt app --text "value"    # accept a prompt with text; dialog_not_prompt otherwise
```

A click or eval that opens a dialog does not return until the dialog closes. In `argus session`, queue the dialog command right behind it; it runs as soon as the dialog appears ([SESSION.md](./SESSION.md#semantics)).

## Init Scripts

`argus page init-script add/ls/rm/clear` registers scripts that run before page code in every new document and survive reloads/reattach. See [INJECT.md](./INJECT.md#init-scripts).
