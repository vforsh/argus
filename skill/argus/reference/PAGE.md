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
argus page reload <targetId> --param foo=bar        # reload any CDP target, optionally rewriting query
```

- A bare token without `/`, `?`, `#`, or `.` is a **host**: `goto app settings` → `http://settings/`. Write `/settings`.
- Every `goto`/`back`/`forward` returns `epoch` in `--json` for race-free log reads ([LOGS.md](./LOGS.md)).
- `--wait none` returns as soon as Chrome accepts the command and reports the requested URL. There is no `networkidle`; use `net watch --settle` ([NET.md](./NET.md)). Same-document navigations and bfcache restores settle immediately.
- Navigation is tab-scoped even with an iframe selected; the selection persists and `extension_frame_not_ready` recovery applies.
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

## CPU Throttle

```bash
argus throttle set app 4        # 4× slowdown; 1 = none
argus throttle status app
argus throttle clear app
```

## Dialogs

Chrome exposes one active JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) at a time; while open, most CDP calls fail with `dialog_blocking`.

```bash
argus dialog status app --json            # active dialog or null
argus dialog accept app                   # OK / Leave
argus dialog dismiss app                  # Cancel / Stay
argus dialog prompt app --text "value"    # accept a prompt with text; dialog_not_prompt otherwise
```
