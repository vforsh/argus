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

- **Control watcher** (`extension-control`, `extension-control-2`, …): one per browser instance, auto-named in startup order. With one live control, commands use it; with several, commands without `--id <controlWatcherId>` fail with `ambiguous_control` (JSON lists `candidates`).
- **Tab watcher**: created per attached tab, named by `--as <id>` or auto (`extension`, `extension-2`, …). An `--as` name held by another live watcher fails with `watcher_id_taken`; re-attaching the tab that already owns it reuses it. All normal commands (`logs`, `eval`, `click`, …) take this id.
- **Registry ownership**: each run records a random `ownerId` (also in `/status`) and `extensionRole`. Only the owner refreshes or removes its entry, so concurrent browsers, overlapping reloads, and crashed hosts never overwrite or delete each other's records. `ext doctor` flags entries from older hosts (no `ownerId`); reload the extension or restart the browser to respawn them.
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

With two extension instances, pick a control from the `ambiguous_control` candidates (or `argus list`), then use the same id for discovery and action:

```bash
argus ext tabs --id extension-control-2 --url portal.example --json
argus ext use --id extension-control-2 --tab <tabId> --as app --json
argus ext doctor --watcher app --json          # finds the owning control instance
```

`--id` (or `--browser <label|instanceId>`) also works on `attach`, `detach`, `show`, `targets` (with a tab selector), `mute`, `unmute`, and `doctor`. Tab ids and URL matches are resolved only inside the selected browser. A successful `/attach` now waits for watcher bootstrap; initialization failures release the debugger and remove the tab session. CLI `--no-wait` skips its final status poll, so use the default when the next command needs the watcher immediately.

## Bind an Agent-Opened Tab

An agent's browser API (Codex @Browser, CUA) hands out tab handles Argus can't see, and the destination URL can't distinguish its tab from same-URL tabs elsewhere. Bind by one-time ticket instead:

```bash
argus ext bind prepare --to https://web.max.ru/ --json    # { ticket, bindUrl, destination, expiresAt }
# agent opens bindUrl (a waiting page on a local watcher, http://127.0.0.1:<port>/bind?ticket=…) in its tab
argus ext bind <ticket> --as max --label codex --visibility background --json
```

- Searches every live control; exactly one tab whose URL carries the ticket is bound. Several → `ambiguous_tab` (never the first); none → `not_found` with `searched` and `unreachable` controls (unreachable means unknown, not absent).
- Tickets: ~60s, single-use, stored in `$ARGUS_HOME/bind-tickets.json`. Spent only on success; a failed bind can be retried with the same ticket before expiry, including after navigation removes the URL locator. An exclusive claim rejects concurrent attempts with `bind_ticket_used`; a crashed CLI's claim can be reclaimed after its PID exits. TTL is never extended by retries.
- Before navigation, bind persists the exact control run, browser instance, tab, watcher run, and progress. Retry verifies those identities and skips a completed navigation. A lost navigation response may require repeating navigation on that same watcher. Closing/replacing the tab or restarting/replacing either watcher requires a new ticket; bind never follows a reused watcher name (`registration_conflict` for identity mismatches).
- `prepare` probes live controls for the actual HTTP bind page and chooses a supported host; `ownerId` and version strings do not prove support. No capable host → `not_available` with upgrade/reload guidance.
- Idempotent: a tab already attached reuses its watcher (`reused: true`); nothing unrelated is detached. A different `--as` than the tab's watcher fails.
- `--visibility foreground|background` applies a shown lock in the same call; result `visibility` reports it (`default` when none). Like `page show --policy`, it validates GET `/visibility` before a policy mutation; unsupported hosts fail with `not_available` without POST/foreground fallback.
- Attach errors preserve the canonical `{ ok: false, error: { message, code? } }` envelope, including `watcher_id_taken` and `tab_owned_by_other_debugger` across bind/use/show/attach flows.
- `--label` records the bound browser instance under that label (the bind proves which browser the agent drives).
- Closing the tab releases its watcher. Keep the agent's tab handle (and hand it off) when the tab must outlive the turn.

## Browser Instances

Each browser profile running the extension has a persistent random `instanceId` (extension storage; survives browser restarts and extension reloads, not reinstall).

```bash
argus ext browsers --json                         # instanceId, label, controlId, state, extension/host versions, tabCount
argus ext browsers label <instanceId> chrome      # manual label (live instance only)
argus ext tabs --browser codex                    # any control command: --browser <label|instanceId> instead of --id
```

Labels come only from `ext browsers label` or `ext bind --label`; a matching URL or extension id never implies one. A label on several live instances fails with `ambiguous_browser`.

## Version Skew

Chrome keeps native hosts running until it respawns them, so after upgrading Argus they may still run the old build. `ext doctor` (`versionSkew` in JSON) and `argus list` compare each host's watcher version with the CLI's and say what to do: reload the extension at `chrome://extensions` or restart the browser. Doctor also flags hosts registered without `ownerId` (pre-ownership builds).

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

- Argus reconnects debugger attachments it still owns (after extension state loss) by verifying ownership with a CDP command. Other debuggers are never disconnected; when Chrome refuses because one holds the tab, attach fails with `tab_owned_by_other_debugger`. Close DevTools / the other debugger and retry.
- Attach/detach requests are serialized per tab; a failed init releases the debugger and removes the tab bridge.
- CLI, watcher, and extension package versions advance independently. Their native-messaging protocol version is checked at handshake; a mismatch rejects the bridge before attachment.
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
