# Network

Request summaries buffered per watcher, with bodies fetched lazily, plus WebSocket/SSE listing, HAR export, and request mocking.

## Read

```bash
argus net app --since 5m
argus net app --grep api --json
argus net app --after 42 --limit 100          # paginate by Argus request id
argus net summary app                          # counts by host/type/status
argus net tail app --grep api --json           # long-poll stream (NDJSON); --timeout <ms>
argus net clear app                            # reset buffer
```

## Filters (all list/summary/watch/export/inspect commands)

| Flag                               | Meaning                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `--grep <substr>`                  | Substring over redacted URLs                                          |
| `--host <h>` / `--ignore-host <h>` | Include / exclude hosts (repeatable)                                  |
| `--ignore-pattern <substr>`        | Exclude URLs containing substring (repeatable)                        |
| `--method <m>`                     | HTTP method (repeatable)                                              |
| `--status <s>`                     | Status or class: `404`, `4xx` (repeatable)                            |
| `--resource-type <t>`              | CDP type: `Fetch`, `XHR`, `Document`, `Script`, `Image`, `WebSocket`… |
| `--mime <prefix>`                  | MIME prefix, e.g. `application/json`                                  |
| `--first-party` / `--third-party`  | Relative to the page origin                                           |
| `--failed-only`                    | Network errors / aborted                                              |
| `--slow-over <duration>`           | Duration threshold                                                    |
| `--large-over <size>`              | Size threshold (`100kb`, `2mb`)                                       |
| `--since <duration>`               | Time window                                                           |
| `--scope <s>`                      | `selected` (iframe target), `page` (default), or `tab`                |
| `--frame <f>`                      | Explicit frame id, or `selected` / `page`                             |

Extension mode with an iframe selected: `net` still defaults to the **top page**; pass `--scope selected` to see the iframe's traffic. Reload-driven commands (`net watch/export/inspect --reload`) reject `--scope selected`.

## Fresh Capture Window

```bash
argus net watch app --reload --settle 3s                     # clear, reload, wait for quiet
argus net watch app --reload --settle-after "window.appReady" --settle 2s --settle-after-interval 100ms
argus net watch app --reload --ignore-cache --ignore-pattern /poll --max-timeout 30s
argus net watch app --settle 2s --no-clear                   # keep buffer, wait for quiet only
```

`--settle` is the quiet window (no new matching requests); `--settle-after <expr>` delays the countdown until the expression is truthy; `--max-timeout` caps the whole wait.

## One Endpoint

```bash
argus net inspect /api/init app --reload                    # newest URL match after a fresh capture
argus net inspect /api/init app --reload --request --response --json
argus net inspect /api/post app --settle-after "window.appReady" --settle 400ms
argus net show 42 app                                       # headers (redacted), initiator, redirects, timing, cache/SW flags
argus net show 90829.507 app                                # raw CDP requestId also accepted
argus net body 42 app                                       # response body (lazy fetch)
argus net body 42 app --request                             # request body
```

## WebSockets / SSE

```bash
argus net ws app --grep socket
argus net ws show 1 app                                     # handshake headers + recent frame previews
argus net sse app --mime text/event-stream                  # request-level only; CDP does not expose SSE payloads
```

## Export

```bash
argus net export app --out boot.har
argus net export app --reload --settle 3s --first-party --out boot.har --json
```

## Mocks

CDP Fetch interception: block, fail, stub, delay, rewrite. Rules persist across reloads/reattach until removed; first match wins.

```bash
argus net mock add app --url "*/analytics/*" --block                            # BlockedByClient
argus net mock add app --url "*/api/save" --fail ConnectionRefused --times 1    # TimedOut, ConnectionRefused, …
argus net mock add app --url "*/api/config" --status 200 --body-file ./fixtures/config.json
argus net mock add app --url "*/api/config" --status 500 --body '{"error":"maintenance"}' --header "x-mock: 1"
echo '{"flags":{"x":true}}' | argus net mock add app --url "*/api/flags" --body -
argus net mock add app --url "*/api/*" --method POST --delay 2s                 # pass-through + latency
argus net mock add app --url "*/api/*" --set-header "x-debug: 1"               # request header override
argus net mock add app --url "cdn.prod.com" --rewrite-host localhost:3000      # host, or origin when value has ://
argus net mock add app --scope selected --url "*/api/config" --status 200 --body-file ./c.json   # selected iframe
argus net mock ls app                                                           # with hit counts
argus net mock rm 2 app
argus net mock clear app
```

- `--url` is a case-insensitive wildcard over the full URL; no `*` means substring. Narrow with `--method`, `--resource-type`.
- Exactly one primary action: `--block`, `--fail <reason>`, or `--status`/`--body`/`--body-file` (+ `--header`). Without one, the rule passes the request through with optional `--delay`, `--set-header`, `--rewrite-host`.
- `--times N` limits any rule. `--scope page` (default) vs `--scope selected` (`--frame` alias); selected rules follow target changes and re-arm after reload.
