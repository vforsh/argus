---
name: argus
description: Guides use of the Argus CLI to debug and inspect web apps via Chrome CDP or the Argus Chrome extension, including authenticated browser sessions, iframe targets, logs, eval, DOM, network, and screenshots.
metadata:
  cli-version: 0.5.41
---

# Argus CLI

Drive a live Chromium tab from the shell. A **watcher** attaches to one tab (or iframe); every command takes its id first, or `@<url/title substring>`. `argus <cmd> --help` lists every flag with examples — use it instead of re-reading this file.

## Rules

1. **Never `sleep`, never poll in bash or in `eval`.** Actions wait *after* themselves, reads wait *before* themselves, with the same flags: `--settle` (page stopped moving) or `--until "<expr>"` (state reached). Standalone: `argus wait app --global app.ready | --gone ".spinner" | --idle | "<expr>"`.
2. **Read with `probe`, lists with `dom info --props`; `eval` is the last resort** (real scripts only). No `JSON.stringify`, `try/catch`, `?.` chains, or `Array.from(querySelectorAll).map` inside eval.
3. **Two or more commands → one `argus run app -e '…' -e '…'`**: one process, one turn.
4. **stdout is the payload; headers, hints, and warnings go to stderr.** Never `2>&1 | tail`, `| head`, `| grep`, `| python`: shape with `--fields a,b.c`, `--max-chars N`, `-q`, `--limit`, `--since`.
5. `--json` when you will parse. Failures are one `{"ok":false,"error":{"message","code"}}` on stdout plus a non-zero exit ([codes](#error--next-command)).

## Task → Command

| Task | Command |
| --- | --- |
| Attach to the user's Chrome (logins, cookies) | `argus ext use --url <substr> --as app` |
| Fresh isolated Chrome | `argus start --id app --url localhost:3000 --headless --profile temp --detach --json` |
| Which watchers exist | `argus list` (`id · state · title · age`; `--verbose` for details) |
| Read page values | `argus probe app url=location.href ready='!!window.app?.ready' n='document.querySelectorAll(".row").length'` |
| Read a list of elements | `argus dom info app --selector ".row" --all --props text,rect,class,disabled,attr:data-id` |
| Click / type, then wait | `argus click app --testid save --settle` · `argus fill app --selector "#q" "hi" --until "<expr>"` |
| Wait for state | `argus wait app --global appctl.ready` · `--gone ".spinner"` · `--idle` |
| Wait, then read | `argus probe app score=app.score --until 'window.app?.ready'` (also `eval`, `dom info`, `screenshot`, `logs`, `net`) |
| Unknown page: what can I click | `argus snapshot app -i` → `argus click app --ref e12` |
| Errors after an action | `c=$(argus logs cursor app)`; act; `argus logs app --after "$c" --levels error,exception` |
| Failed / slow requests | `argus net app --failed-only` · `argus net show 42 app` · `argus net body 42 app` |
| Screenshot | `argus screenshot app --out shot.png --settle` |
| localStorage | `argus storage local list app` · `argus storage local get app <key>` |
| IndexedDB | `argus storage idb ls app` · `argus storage idb get app <db> <store>` |
| Reset to a first visit | `argus storage clear app --reload` (IndexedDB, local/session storage, cookies, caches, SW) |
| Navigate | `argus goto app /checkout` · `argus reload app` (both settle by default) |
| Multi-line script | `argus eval app --stdin <<'EOF'` … `EOF` (no scratch file) |

## Verify A Change (canonical)

```bash
argus run app -e 'reload' -e 'wait --global app.ready' -e 'probe url=location.href err=window.__lastError' -e 'screenshot --out after.png'
argus logs app --since 1m --levels error,exception
```

`run` prints `✓ n cmd (ms) → result` per step and stops at the first failure; an unquoted `eval`/`wait` expression keeps its spaces and quotes up to the first flag (`-e 'eval await app.use("x") --timeout 40s'`); `--keep-going` runs every step (use it for diagnostics), `--json` returns `{ ok, steps: [{ step, cmd, ok, result | error }] }`.

---

## Golden One-Liners

```bash
# connect
argus ext use --url portal.example --as app --json                  # user's Chrome via extension (one-time: argus extension install)
argus start --id app --url localhost:3000 --headless --profile temp --detach --json   # isolated CDP Chrome
# do three things to a page, one turn
argus run app -e 'click --testid play --settle' -e 'probe score=appctl.score' -e 'screenshot --out a.png'
# click and wait for the result
argus click app --testid save --until "document.querySelector('.toast-saved')" --json
# read several values; a throwing key reports {"__error": "..."} and the rest still answer
argus probe app user='store.getState().user.id' cart='store.getState().cart.items.length' consent='CONSENT.get()'
# read a list of elements as rows
argus dom info app --selector ".shelf-item" --all --pick '({ id: el.dataset.id, w: el.offsetWidth })'
# network after an action
argus net app --since 30s --failed-only
# logs since a marker
c=$(argus logs cursor app); argus click app --testid buy --settle; argus logs app --after "$c" --levels error,warning
```

`probe` details: [EVAL.md](./reference/EVAL.md#probe-several-reads-one-round-trip). `--props` columns: [DOM.md](./reference/DOM.md#read-a-list-of-elements). Waiting: [INTERACT.md](./reference/INTERACT.md#wait-for-the-result---until).

## Pick A Mode

| Need | Mode | Connect with |
| --- | --- | --- |
| User's real Chrome: saved login, cookies, extensions, open tabs | **Extension-control** | `argus ext use --url <substr> --as <id>` |
| Isolated/temp profile, headless, custom CDP port, startup injection, clean repro | **CDP** | `argus start --id <id> --url <url>` |
| App inside an iframe of a host page | either + iframe select | `--iframe-url` (ext) / `--type iframe` (CDP) |
| WebView in an Android app over USB | **Android** | `argus android attach --package <pkg> --id <id>` |

Never use `argus start`, `--profile temp`, or headless for a flow that needs the user's login. Details: [EXTENSION.md](./reference/EXTENSION.md), [START.md](./reference/START.md), [IFRAMES.md](./reference/IFRAMES.md), [ANDROID.md](./reference/ANDROID.md).

**Extension**: `argus ext doctor --json` (healthy?), `argus ext tabs --url <substr> --json` (pick; ambiguous matches fail closed), `argus ext use --tab <tabId> --as app` (exact tab), `--pick newest|active|first`, `argus ext use --open <url> --as app` (reuse or open). Agent-opened tabs (Codex @Browser, CUA) bind by ticket, never by URL: `argus ext bind prepare --to <url> --json` → open `bindUrl` in that tab → `argus ext bind <ticket> --as app --json`. Several browsers running Argus → `ambiguous_control`; pick with `--id <controlId>` or `--browser <label>`. Embedded app: `argus ext use … --iframe-url game.example`, switch with `argus ext select app --iframe-url … | --page`; after a reload, `argus reload app --until "window.app?.ready"` waits inside the re-created iframe.

**CDP**: `argus start` = Chrome + watcher in one process (`up` is an alias); `--detach` returns once attached with ids/PIDs (`--json`), stop with `argus watcher stop <id>` (also closes its Chrome and temp profile). Add `--owner-pid <your long-lived pid> --idle-exit 15m --label session=<id>` so a killed session can't leak watchers; `argus watcher stop --label session=<id>` stops only yours ([START.md](reference/START.md)). Headless defaults to 1280×900 @1x (`--width/--height/--dpr`); `--user-agent regular-chrome` hides the headless marker; `--auth-from <ext-watcher>` clones a login into the temp Chrome.

**Long-running** (run in background): `start` without `--detach`, `chrome start`, `watcher start`, `android attach`, `page open --attach`, `logs tail`, `net tail`, `net ws tail`, `net sse`, `session`.

---

## Waiting, In Full

- `--settle`: document loaded, no open request for 500ms, then the app's optional `window.__argus.settle()` hook (return `false` for "not yet") and two frames. Navigations settle by default (`--no-settle` opts out). Best effort: a miss warns and continues (`settle.settled: false`, exit 0). `--settle-timeout` (default 10s).
- `--until <expr>`: truthy page expression (throws count as "not yet"); `--until-timeout` (default 15s). A miss exits 1 with `wait_timeout`, `lastState`, and the last value — after an action the action already ran, so don't blindly repeat it. Polls never match the document a navigation left.
- `argus wait`: `--global a.b.c` (dotted path truthy), `--gone <selector>`, `--idle` (= `--settle`), or an expression; `--total-timeout`, `--fail-on-exception`.
- Apps with their own idle signal expose it once: `window.__argus = { settle: () => store.idle() }`.
- `eval` prints a stderr `hint:` before its result when it sees `setTimeout`/`new Promise` polling or a multi-key `JSON.stringify({…})`; each hint shows at most once per 30 min (`ARGUS_NO_HINTS=1` silences hints).

## Conventions

- **Output**: every command takes `-q` (silent on success), `--max-chars <n>`, and with `--json` also `--fields a,b.c` (implies `--json`; arrays project each element). Piped human output is capped at 20000 chars (`ARGUS_MAX_CHARS=<n>`, `0` disables); piped `net`/`logs` without a bound show the newest 100 rows. `--json` is never capped implicitly. `--out` files are never shaped. `net` rows show `data:` URIs as `data:image/png;base64,…(342b)`.
- **Durations**: `500ms`, `5s`, `2m`; bare numbers are milliseconds.
- **`--json` failures**: branch on `ok`, then `error.code`. Bad flags exit 2 with `invalid_request`; unknown watcher ids add `candidates`; a thrown eval adds `exception: { text, description }`.
- **Targets**: `--selector`, `--testid`, `--ref eN` (from `snapshot`), `--pos x,y`; `--text /regex/` filters by trimmed text; `--all` allows several matches.
- **`--out` paths** are relative to *your* cwd; responses return absolute `outFile`.
- **Selected iframe** (extension mode) is the target for eval/DOM/interaction/capture and the default `net` scope (`--scope tab|page` opts out).
- **Keyboard** needs focus: `keydown` activates a hidden page (`activated: true`); release with `argus page hide app`. `argus page show app` keeps timers unthrottled while covered.
- **Extension limits**: one debugger per tab, the orange "debugging" bar stays, the tab must stay open.
- **Scenarios** (multi-step TypeScript with screenshots/checkpoints): `argus eval app --file ./scenario.ts --arg level=3 --json` ([EVAL.md](./reference/EVAL.md#typescript-scenarios)). A JSON harness uses `argus session app` (JSONL) ([SESSION.md](./reference/SESSION.md)).
- `locate` (find by role/label/text, `--action click|fill`) is niche: `click --testid/--text` and `snapshot -i` + `--ref` cover the same ground ([DOM.md](./reference/DOM.md#discovery)).
- Install: `npm i -g @vforsh/argus` (or `npx -y @vforsh/argus`). `argus skill` prints this file's path; `reference/` sits next to it. `logs --raw`, WebSocket frames, code deminify and the rest live in the references below.

## Command Map

| Area | Commands | Reference |
| --- | --- | --- |
| Launch / lifecycle | `start`/`up`, `chrome *`, `watcher *`, `page open --attach`, `config init`, `doctor`, `list` | [START.md](./reference/START.md) |
| Extension | `extension install/doctor/tabs/use/bind/attach/select/targets/detach/show/mute/diagnose/recover` | [EXTENSION.md](./reference/EXTENSION.md) |
| Iframes | CDP target flags, `ext select` | [IFRAMES.md](./reference/IFRAMES.md) |
| Android WebView | `android attach/doctor` | [ANDROID.md](./reference/ANDROID.md) |
| Logs | `logs`, `logs cursor/epoch/tail` | [LOGS.md](./reference/LOGS.md) |
| Read / eval | `probe`, `eval`/`js`, `eval-until`/`wait`, scenarios, `--arg`, polling | [EVAL.md](./reference/EVAL.md) |
| DOM & discovery | `dom info --props/--pick`, `dom tree/focus/add/add-script/remove/modify/set-file/scroll`, `snapshot`, `locate` | [DOM.md](./reference/DOM.md) |
| Interaction | `click`, `drag`, `hover`, `fill`, `keydown`, `scroll-to`, `--wait-nav` | [INTERACT.md](./reference/INTERACT.md) |
| Page | `goto/back/forward/url/reload`, `page ls/activate/close`, visibility, emulation, throttle, dialogs | [PAGE.md](./reference/PAGE.md) |
| Capture | `screenshot`, `record`, `trace` | [CAPTURE.md](./reference/CAPTURE.md) |
| Perf | `perf gesture/capture/motion/compare`, `input record/replay`, `trace analyze` | [PERF.md](./reference/PERF.md) |
| Network | `net`, `net watch/inspect/show/body/summary/export/ws/sse/mock/cache clear` | [NET.md](./reference/NET.md) |
| Auth & storage | `auth cookies/export-state/load-state/clone`, `storage local/session/idb/clear` | [STATE.md](./reference/STATE.md) |
| Runtime code | `code ls/read/grep/deminify/edit/strings` | [CODE.md](./reference/CODE.md) |
| Injection | `page init-script`, `--inject`, config `inject`, `window.__ARGUS__` | [INJECT.md](./reference/INJECT.md) |
| Batches / session | `run -e`, `run --file`, `session` (JSONL) | [SESSION.md](./reference/SESSION.md) |
| Plugins | `plugin list/add/remove`, `--plugin` | [PLUGINS.md](./reference/PLUGINS.md) |

## Error → Next Command

Read the code before retrying or raising a timeout.

| Code | Meaning | Do |
| --- | --- | --- |
| `watcher_not_found` | id / `@page` not found (`candidates` lists live ids) | `argus list`, `argus watcher prune`, reattach |
| `watcher_id_required` | no id, or `@page` matched several | pass an id or a longer `@` substring |
| `eval_exception` | the expression threw | read `exception.description`; fix it, don't retry (or use `probe`, which isolates throws) |
| `wait_timeout` | `--until` / `wait` never truthy | read `lastState`/`last`; the action (if any) already ran |
| "failed to reach watcher" | process gone / hung | `argus watcher status <id>`, `argus doctor` |
| `chrome_unreachable` | CDP endpoint down | `argus chrome status --cdp 127.0.0.1:9222`; restart Chrome |
| `cdp_not_attached` | watcher has no target yet | check `--url/--type`; `argus page ls --tree` |
| `cdp_target_replaced` | target swapped, reattaching | retry |
| `cdp_renderer_unresponsive` | main thread blocked | `argus reload <id>` |
| `cdp_timeout` | expression exceeded its deadline | the only case a longer `--timeout` fixes; for waits use `wait` |
| `extension_bridge_unresponsive` | extension worker/native channel stalled | `argus ext doctor --watcher <id>`; reload the extension |
| `dialog_blocking` | alert/confirm/prompt open | `argus dialog accept <id>` / `dialog dismiss <id>` |
| `navigation_pending` | still on the pre-navigation document | `--until` treats it as "not yet"; a miss with it means the navigation never committed |
| `extension_frame_missing` / `_not_ready` | selected iframe not back / still booting | `reload --until …`, `argus ext targets <id> --tree`, or `ext select` |
| `target_not_focused` | page could not be activated for keyboard | `argus page show <id>`, retry |
| `multiple_matches` | selector hit >1 element | narrow it, add `--text`, or `--all` |
| `not_interactable` | element hidden/covered/zero-size | `scroll-to`, `dom info --props visible,rect`, wait for state |
| `navigation_failed` / `navigation_timeout` | Chrome refused the URL / load phase late | fix URL or server / `--wait domcontentloaded` |
| `no_history` | at first/last history entry | check `index`/`length` in `page back --json` |
| `log_epoch_*` | cursor from another session / evicted | take a fresh `logs cursor` |
| `not_available` | capture under background policy, or old watcher | `page show --policy foreground`; restart the watcher |
| `watcher_id_taken` | name held by another live watcher | `argus watcher stop <id>` or another `--id`/`--as` |
| `unknown option` / `unknown command` on a flag this file documents | installed CLI may be older than this file | compare `argus --version` with `metadata.cli-version` above (CLI ≥ 0.5.41 prints a `hint:` itself); if older, `bun add -g @vforsh/argus@latest`, then retry |
| `trace_conflict` | Chrome already tracing | `argus trace stop <holder>` (named in the message) |
| `ambiguous_control` / `ambiguous_browser` / `ambiguous_tab` | several browsers / labels / bind tabs match | `--id <controlId>` or `--browser <label>`; close extra tabs |
| `bind_ticket_expired` / `_used` | ticket older than ~60s / already bound | `argus ext bind prepare --to <url>` again |
| `tab_owned_by_other_debugger` | DevTools/other debugger holds the tab | close it, retry |
| Popup dead / no control watcher | extension worker gone | `argus ext diagnose --out ./inc-1`, then `ext recover` ([runbook](./reference/EXTENSION.md#incident-runbook)) |
