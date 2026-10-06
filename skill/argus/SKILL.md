---
name: argus
description: Guides use of the Argus CLI to debug and inspect web apps via Chrome CDP or the Argus Chrome extension, including authenticated browser sessions, iframe targets, logs, eval, DOM, network, and screenshots.
---

# Argus CLI

Terminal control of a live Chromium page: logs, eval, DOM, interaction, network, screenshots, recordings. A **watcher** process attaches to one tab (or iframe) and serves a local HTTP API; every CLI command takes the watcher id as its first positional argument and supports `--json`.

```bash
npm i -g @vforsh/argus        # or: npx -y @vforsh/argus --help
argus --help
argus <cmd> --help            # every command has flags + examples
argus skill                   # absolute path of this SKILL.md (reference/ sits next to it)
```

---

## Pick A Mode

| Need                                                                             | Mode                   | Connect with                                 |
| -------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
| User's real Chrome: saved login, cookies, extensions, already-open tabs          | **Extension-control**  | `argus ext use --url <substr> --as <id>`     |
| Isolated/temp profile, headless, custom CDP port, startup injection, clean repro | **CDP**                | `argus start --id <id> --url <url>`          |
| App lives inside an iframe of a host page                                        | either + iframe select | `--iframe-url` (ext) / `--type iframe` (CDP) |

Never use `argus start`, `--profile temp`, or headless for a flow that needs the user's login. Details: [EXTENSION.md](./reference/EXTENSION.md), [START.md](./reference/START.md), [IFRAMES.md](./reference/IFRAMES.md).

**Long-running commands** (`start`, `chrome start`, `watcher start`, `page open --attach`, `logs tail`, `net tail`, `net sse`, `session`) never exit on their own. Run them in the background in agent shells.

---

## Connect: Extension-Control

One-time: `argus extension install` (installs native hosts, opens `chrome://extensions`, waits for connect).

```bash
open -a "Google Chrome" "https://portal.example/app"
argus ext doctor --json                              # bridge + extension healthy?
argus ext tabs --url portal.example --json           # pick the tab; ambiguous matches fail closed
argus ext use --url portal.example --as app --json   # attach (or reuse) → watcher id "app"
argus ext use --tab <tabId> --as app                 # exact tab when several match
argus page url app
```

If Chrome and Codex @Browser both run Argus, control commands without `--id`/`--browser` fail with `ambiguous_control` and list the candidates; pick one and use it consistently (`--browser <label>` works once labeled): `argus ext tabs --id extension-control-2 --json`, then `argus ext use --id extension-control-2 --tab <tabId> --as app`. `--id` also selects the control instance for `attach`, `detach`, `show`, `targets` (when resolving a tab), `mute`, and `unmute`. `ext doctor --watcher app` finds its owning control; `--id` selects one explicitly. Explicit names are exact: `--as`, `start --id`, and `watcher start --id` fail with `watcher_id_taken` while another live watcher holds the name (no silent `app-2`). A successful attach means the tab watcher completed bootstrap; `--no-wait` skips only the CLI's final status poll.

**Agent-opened tab (Codex @Browser, CUA): bind by ticket, never by URL.** Same-URL tabs in other chats or browsers make URL matching unsafe.

```bash
argus ext bind prepare --to https://web.max.ru/ --json   # → { ticket, bindUrl, expiresAt } (~60s)
# open bindUrl in the agent's tab (keep the browser handle), then:
argus ext bind <ticket> --as max --label codex --visibility background --json
# → { watcherId, tabId, url, control, browser: { instanceId, label }, attached, reused, targetReady, visibility }
argus ext tabs --browser codex --json                    # later: select that browser by label
```

`bind` searches every live browser, attaches (or reuses the tab's watcher: `reused: true`), navigates to the destination, and waits for the debugger target. `targetReady` is debugger readiness, not app health. Failures: `bind_ticket_expired`, `bind_ticket_used`, `ambiguous_tab` (ticket open in several tabs), `not_found` (lists searched and unreachable controls). Closing the tab releases its watcher. `argus ext browsers` lists instances (persistent `instanceId`, label, control, versions); `ext browsers label <instanceId> <label>` labels one manually.

Failed binds can resume with the same ticket before expiry, even after navigation removed its URL locator. Retry keeps the selected browser/tab/watcher run and skips completed navigation; an owner/endpoint replacement fails with `registration_conflict`. Concurrent attempts return `bind_ticket_used`. `prepare` probes the real bind page; old hosts without it return `not_available`. Background visibility requires policy support and never falls back to foreground activation. Attach failures retain codes such as `watcher_id_taken` and `tab_owned_by_other_debugger`.

Embedded app: `argus ext use --url portal.example --as app --iframe-url game.example`; later switch with `argus ext select app --iframe-url … | --iframe-title … | --page`. Commands then run inside the selected iframe (eval, DOM, click, screenshot, `net --scope selected`). Reload stays tab-scoped; a selected iframe that is missing waits 3s then fails `extension_frame_not_ready` instead of silently using the host page.

Tab stuck in background or booting: `argus ext show app` then `argus reload app`.

---

## Connect: CDP

```bash
argus start --id app --url localhost:3000            # Chrome + watcher, one process (background it)
argus start --id app --url localhost:3000 --headless --profile temp
argus start --id app --url https://example.com --headless --profile default-medium --user-agent regular-chrome
argus start --id app --auth-from ext-watcher --url https://target.app/   # clone login into temp Chrome
```

Split form: `argus chrome start --url …` then `argus watcher start --id app --url localhost:3000 --chrome-port 9222`. In headless mode, `--user-agent regular-chrome` removes Chrome's headless UA marker before the first request; use `default-medium` when auth also needs Local Storage or IndexedDB. Chrome is muted by default (`--no-mute`). Default profile mode `default-lite` copies cookies/logins from the user's Chrome into a temp dir; `temp` is empty. Iframe/worker targets: `--type iframe --url … | --origin … | --target <id> | --parent <substr>`.

---

## Core Loop

```bash
argus list                                           # watchers + Chrome instances
argus logs app --since 10m --levels error,warning
argus screenshot app --out shot.png
argus snapshot app --interactive                     # a11y tree with refs (e5, e12…)
argus eval app "({ title: document.title, href: location.href })" --json
argus wait app "document.readyState === 'complete'" --total-timeout 30s
```

**Race-free verification**: take a cursor, act, read only what followed.

```bash
c=$(argus logs cursor app)
argus click app --selector "button.save"
argus logs app --after "$c" --levels error,exception --json
```

`goto`, `back`, `forward`, and `click/keydown --wait-nav` return an `epoch` for the same purpose: `argus logs app --since-epoch "$epoch"`.

**Navigate**: `argus goto app /checkout` (relative, `?tab=2`, `#top`, `localhost:3000` all resolve in the watcher), `argus page back app`, `argus reload app`. Bare `settings` is a host, write `/settings`.

**Interact**: `click`, `drag`, `hover`, `fill`, `keydown`, `scroll-to`. Target with `--selector`, `--testid`, `--ref eN` (from `snapshot`/`locate`), or `--pos x,y`. `--all` allows multiple matches; `--text /regex/` filters by content; `--wait 5s` polls for the selector. `argus locate role app button --name Save --action click` finds and acts in one step.

**Multi-step suites**: write a bundled TypeScript scenario (`export default async function scenario(ctx)`) and run `argus eval app --file ./scenario.ts --arg level=3 --json`; `ctx` exposes screenshots, checkpoints, recordings, and log sessions. Many sequential commands from a harness: `argus session app` (JSONL over stdin, one process).

---

## Conventions

- **Durations**: `500ms`, `5s`, `2m`, `1h`; bare numbers are milliseconds.
- **`--out` paths** (`screenshot`, `record`, `trace`, `eval --out`) are absolute or relative to _your_ cwd. Response `outFile` is absolute.
- **Selected iframe** (extension mode) is the target for eval/DOM/interaction/capture. Network defaults to the top page; add `--scope selected`.
- **Keyboard needs focus**: `keydown` activates a hidden page (same sticky lock as `page show`) and reports `activated: true`; release with `argus page hide app`.
- **Visibility lock**: `argus page show app` keeps timers/rAF unthrottled while covered. `--policy background` does it without stealing OS focus, but screenshots/recordings then return `not_available`.
- **Extension mode limits**: one debugger per tab, orange "debugging" bar is permanent, tab must stay open.

---

## Command Map

| Area               | Commands                                                                                           | Reference                                |
| ------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Launch / lifecycle | `start`, `chrome *`, `watcher *`, `page open --attach`, `config init`, `doctor`, `list`            | [START.md](./reference/START.md)         |
| Extension          | `extension install/doctor/tabs/use/attach/select/targets/detach/show/mute/diagnose/recover`        | [EXTENSION.md](./reference/EXTENSION.md) |
| Iframes            | CDP target flags, `ext select`                                                                     | [IFRAMES.md](./reference/IFRAMES.md)     |
| Logs               | `logs`, `logs cursor/epoch/tail`                                                                   | [LOGS.md](./reference/LOGS.md)           |
| Eval               | `eval`/`js`, `eval-until`/`wait`, scenarios, `--arg`, polling                                      | [EVAL.md](./reference/EVAL.md)           |
| DOM & discovery    | `dom tree/info/focus/add/add-script/remove/modify/set-file/scroll`, `snapshot`, `locate`           | [DOM.md](./reference/DOM.md)             |
| Interaction        | `click`, `drag`, `hover`, `fill`, `keydown`, `scroll-to`, `--wait-nav`                             | [INTERACT.md](./reference/INTERACT.md)   |
| Page               | `goto/back/forward/url/reload`, `page ls/activate/close`, visibility, emulation, throttle, dialogs | [PAGE.md](./reference/PAGE.md)           |
| Capture            | `screenshot`, `record` (mp4/webm/gif, `--until`), `trace`                                          | [CAPTURE.md](./reference/CAPTURE.md)     |
| Network            | `net`, `net watch/inspect/show/body/summary/export/ws/sse/mock`                                    | [NET.md](./reference/NET.md)             |
| Auth & storage     | `auth cookies/export-cookies/export-state/load-state/clone`, `storage local/session`               | [STATE.md](./reference/STATE.md)         |
| Runtime code       | `code ls/read/grep/deminify/edit/strings`                                                          | [CODE.md](./reference/CODE.md)           |
| Startup injection  | `--inject`, config `inject`, `window.__ARGUS__`                                                    | [INJECT.md](./reference/INJECT.md)       |
| Session transport  | `session` JSONL protocol                                                                           | [SESSION.md](./reference/SESSION.md)     |
| Plugins            | `plugin list/add/remove`, `--plugin`, plugin contract                                              | [PLUGINS.md](./reference/PLUGINS.md)     |

---

## Error → Next Command

Read the error code before retrying or raising a timeout.

| Code                            | Meaning                                         | Do                                                                                                                  |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Watcher not found               | id not in registry                              | `argus list`, `argus watcher prune`, reattach                                                                       |
| "failed to reach watcher"       | process gone / hung                             | `argus watcher status <id>`, `argus doctor`                                                                         |
| `chrome_unreachable`            | CDP endpoint down                               | `argus chrome status --cdp 127.0.0.1:9222`; restart Chrome                                                          |
| `cdp_not_attached`              | watcher has no target yet                       | check `--url/--type` match; `argus page ls --tree`                                                                  |
| `cdp_target_replaced`           | target swapped, reattaching                     | retry                                                                                                               |
| `cdp_renderer_unresponsive`     | main thread blocked                             | `argus reload <id>`                                                                                                 |
| `cdp_timeout`                   | expression exceeded its deadline                | the only case a longer `--timeout` fixes                                                                            |
| `dialog_blocking`               | alert/confirm/prompt open                       | `argus dialog accept <id>` or `dialog dismiss <id>`                                                                 |
| `extension_frame_not_ready`     | selected iframe missing/booting                 | wait, `argus ext targets <id> --tree`, or `ext select --page`                                                       |
| `target_not_focused`            | page could not be activated for keyboard        | `argus page show <id>` then retry                                                                                   |
| `multiple_matches`              | selector hit >1 element                         | narrow selector, add `--text`, or `--all` (`--nth` on `dom add`)                                                    |
| `not_interactable`              | element hidden/covered/zero-size                | `scroll-to`, `dom info`, wait for state                                                                             |
| `navigation_failed`             | Chrome refused URL (`net::ERR_*`)               | fix URL / start server                                                                                              |
| `navigation_timeout`            | load phase late; page may still load            | `--wait domcontentloaded` or longer `--timeout`                                                                     |
| `no_history`                    | at first/last history entry                     | check `index`/`length` in `page back --json`                                                                        |
| `log_epoch_*`                   | cursor from another session / evicted           | take a fresh `logs cursor`                                                                                          |
| `not_available`                 | capture under background policy, or old watcher | `page show --policy foreground`; restart watcher on current build                                                   |
| `watcher_id_taken`              | name held by another live watcher               | `argus watcher stop <id>` or pick another `--id`/`--as`                                                             |
| `ambiguous_control`             | several browsers run Argus                      | pick from `candidates`: `--id <controlId>` or `--browser <label>`                                                   |
| `ambiguous_browser`             | label on several live instances                 | `argus ext browsers`, relabel one or pass an `instanceId`                                                           |
| `ambiguous_tab`                 | bind ticket open in several tabs                | close extras, or `ext bind prepare` again and open it once                                                          |
| `bind_ticket_expired` / `_used` | ticket older than ~60s / already bound          | `argus ext bind prepare --to <url>` again                                                                           |
| `tab_owned_by_other_debugger`   | DevTools/other debugger holds the tab           | close it, retry the attach                                                                                          |
| Multiple tabs matched (ext)     | ambiguous `--url/--title`                       | `argus ext tabs --url … --json` → `--tab <tabId>`                                                                   |
| Popup dead / no control watcher | extension worker gone                           | `argus ext diagnose --out ./inc-1` first, then `ext recover` ([runbook](./reference/EXTENSION.md#incident-runbook)) |
