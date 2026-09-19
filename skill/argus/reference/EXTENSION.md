# Extension-Control

Debug the user's normal Chrome session (real profile, logins, extensions) without CDP launch flags. The Argus extension attaches Chrome's debugger to a tab and bridges it to a local watcher over Native Messaging.

## Setup (once)

```bash
argus extension install            # installs native hosts, opens chrome://extensions, waits for connect
#   → enable Developer mode, "Load unpacked", pick the folder the command prints
argus extension install --no-wait  # scripted / non-interactive
argus extension path               # folder for "Load unpacked"
argus extension status             # native host config + pinned extension id
argus extension info               # host manifest paths
argus extension remove             # uninstall native hosts
argus extension setup [extensionId]  # hosts only; pass an id only for a differently-keyed build
```

The extension id is pinned via a manifest `key`, and the prebuilt extension ships inside the CLI package. Re-run `argus ext setup` after upgrading Argus so the instrumented host wrappers are current.

## Model

- **Control watcher** (`extension-control`): always-on transport the CLI talks to for tab listing and attach/detach. `ext tabs --id` selects a different transport watcher.
- **Tab watcher**: created per attached tab, named by `--as <id>` or auto (`extension`, `extension-2`, …). All normal commands (`logs`, `eval`, `click`, …) take this id.
- Chrome shows an orange "debugging" bar on attached tabs. It cannot be hidden.

## Attach / Resolve

```bash
argus ext doctor --json                        # bridge health; add --watcher <id> for target readiness
argus ext tabs --url portal.example --json     # list; --title <substr>; ambiguous filters fail closed
argus ext use --url portal.example --as app    # attach, or reuse an existing attachment → prints id
argus ext use --tab 123 --as app
argus ext use --title "Docs" --show            # lock shown+focused after attaching
argus ext attach --url localhost --as app      # attach only (no reuse), --no-wait returns early
argus ext detach --tab 123 | --url … | --title …
argus ext show app                             # attach if needed + sticky shown+focused lock
argus ext mute app / unmute --tab 123          # persistent Chrome tab mute; selectors don't attach
```

Prefer `ext use`: idempotent, returns the watcher id, accepts iframe selection flags. `--tab/--url/--title` on `mute`, `unmute`, `detach`, and `targets` resolve the tab without attaching it.

## Iframe Selection

```bash
argus ext use --url portal.example --as app --iframe-url game.example
argus ext targets app --tree                   # page + iframe targets: attached / available / pending
argus ext select app --iframe-url game.example
argus ext select app --iframe-title "Game Title"
argus ext select app --iframe auto             # heuristic; fails closed when ambiguous
argus ext select app --page                    # back to the host page
```

Prefer `--iframe-url` / `--iframe-title` over `auto`. Once selected, eval, DOM, interaction, and capture run inside the iframe; `net` defaults to the top page unless `--scope selected` ([NET.md](./NET.md)).

**Recovery semantics.** `argus reload <id>` reloads the whole tab. A selected iframe stays selected while it is missing or booting: commands wait up to 3s for readiness, then fail with `extension_frame_not_ready`. They never fall back to the host page. `ext targets --tree` shows the missing frame as `pending` (`attached: true`, `targetReady: false` in JSON). Retry once the iframe loads, or `ext select <id> --page` explicitly. `ext doctor --watcher <id>` separates target readiness from bridge health.

Iframe not appearing after attach:

```bash
argus ext show app && argus reload app
argus wait app "document.querySelectorAll('iframe').length > 0" --total-timeout 30s
argus ext targets app --tree
argus ext select app --iframe-url game.example
```

## Attachment Behavior

- Argus reconnects debugger attachments it still owns (after extension state loss) by verifying ownership with a CDP command. Other debuggers are never disconnected; Chrome's error is surfaced as-is. Release the other debugger and retry.
- Attach/detach requests are serialized per tab; a failed init releases the debugger and removes the tab bridge.
- Explicit detach disposes the tab watcher. Visibility lock/policy and iframe selection must be re-applied after a fresh attach.

## Limitations

- One debugger per tab; tab must stay open.
- Debugging bar is permanent (Chrome security).
- Cross-origin iframes: select them as targets with `ext select` ([IFRAMES.md](./IFRAMES.md)).

## Incident Runbook

Popup will not open, or the control watcher disappeared. **Collect before repairing or reloading.**

```bash
argus ext diagnose --out ./argus-incident-1 --json         # works with a dead worker; --out must be new
argus ext diagnose --out ./argus-incident-2 --platform     # + bounded CPU/RSS samples (no argv/env)
argus ext recover --out ./argus-recovery-1 --watcher app --json          # verify existing selection
argus ext recover --out ./argus-recovery-2 --watcher app --tab 123 --json  # attempt an attach too
```

- `diagnose` writes a pre-probe journal snapshot, doctor results, retained native/worker evidence, and `timeline.txt`. Doctor separates PID existence, local HTTP, control handshake, debugger attachment, and selected-target readiness. Execution is **not** tested until `recover` probes it.
- `recover` saves the incident first, optionally attaches `--tab`, then checks control, attachment, and a bounded `1` evaluation separately.
- The CLI cannot revive a completely dead extension worker in a normal Chrome session. If reported, reload Argus at `chrome://extensions`, then rerun doctor + recover into a new directory and reselect the iframe. A successful reload is an observation, not a root cause.
- Before reloading, also save the extension's Errors panel and `chrome://serviceworker-internals` state. Chrome does not expose worker exit reasons; "no SW", closed stream, or late retry alone prove nothing.
- Evidence retention: extension storage keeps ≤128 events for 7 days (cleared on reinstall); native journals live under `$ARGUS_HOME/incidents` (default `~/.argus/incidents`), ≤16 files of ~256 KiB plus two 64 KiB wrapper logs. Exports omit URLs, titles, cookies, eval payloads, and page content; nothing uploads.
