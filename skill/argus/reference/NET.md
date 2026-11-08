# Network

Request summaries buffered per watcher, with bodies fetched lazily, plus WebSocket frames, SSE listing, HAR export, and request mocking.

## Read

```bash
argus net app --since 5m
argus net app --grep api --json
argus net app --after 42 --limit 100          # paginate by Argus request id
argus net summary app                          # counts by host/type/status
argus net tail app --grep api --json           # long-poll stream (NDJSON); --timeout <ms>
argus net clear app                            # reset buffer
argus net app --json --fields id,method,url,status,durationMs --max-chars 4000
```

**Output shaping** (`net` list only): `--fields a,b.c` keeps only those dot paths of each request; human mode then prints one compact JSON line per request. `--max-chars <n>` keeps leading requests while they fit `n` chars: human mode ends with `… [truncated K of N records; raise --max-chars]`; `--json` switches to `{ "requests": [...], "truncated": bool, "omitted": K }` whenever `--max-chars` is set (a plain array otherwise).

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
| `--scope <s>`                      | `selected` (iframe target), `page`, or `tab` (default; see below)     |
| `--frame <f>`                      | Explicit frame id, or `selected` / `page`                             |

Extension mode with an iframe selected: `net` defaults to `--scope selected` (the iframe's traffic); pass `--scope tab` for the whole tab or `--scope page` for the top frame. Reload-driven commands (`net watch/export/inspect --reload`) reject `--scope selected` and keep `tab` as their default.

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

Captured in both CDP and extension mode (`Network.webSocket*` events of the tab and its iframes).

```bash
argus net app --resource-type WebSocket                     # sockets as WS rows: status, state, frame counts, socket=<n>
argus net ws app --grep socket                              # one line per socket: id, state, status, duration, frames, bytes, url
argus net ws show 1 app                                     # handshake headers + last 20 frame previews
argus net ws frames app                                     # every buffered frame, oldest first, all sockets
argus net ws frames app --socket 1 --direction sent         # one socket (id from `net ws`, or raw CDP requestId); sent|received (out|in)
argus net ws frames app --grep pubsub --match '"type":"message"' --since 2m
argus net ws frames app --json --fields id,direction,payload --max-chars 300
argus net ws tail app --socket 1                            # follow new frames (long-poll); --json = NDJSON {watcher, frame}
argus net sse app --mime text/event-stream                  # request-level only; CDP does not expose SSE payloads
```

Frame line: `<frameId> socket=<n> <ISO time> sent|recv text|binary <size> <payload>`. JSON frame: `id`, `connectionId`, `requestId`, `url`, `ts`, `direction`, `opcode` (1 text, 2 binary), `mask`, `payloadLength` (bytes on the wire), `payload`, `base64Encoded`, `truncated`.

- **Payloads**: text as-is, binary as base64 (human mode prefixes `base64:`). `--max-chars <n>` cuts **each payload** to `n` chars and sets `truncated: true`; the watcher itself keeps at most 64 KiB of characters per frame.
- **Filters** (`frames` and `tail`): `--socket`, `--direction`, `--grep` (socket URL substring), `--match <regex>` (payload, repeatable, any matches, case-insensitive unless `--case-sensitive`; binary matches its base64), `--since`, `--after <frameId>`, `--limit`.
- **`tail`** starts at the newest frame; `--since`/`--after` replay buffered frames first. Ctrl+C stops it.
- **Bounds**: frames share one ring per watcher (same count cap as the request buffer, plus a 16M-character payload budget); the oldest go first. `net clear` drops frames and finished sockets but keeps open ones.
- **Opened before attach**: CDP never replays a socket's handshake, so a socket that was already open shows up on its next frame as `(url unknown: opened before capture)`, with frames from then on. Reload (or reconnect the socket) to get its URL and handshake headers.
- CDP reports data frames only (no ping/pong/close frames, no close code). Socket rows carry no frame id, so `--scope selected` never hides them.

## Export

```bash
argus net export app --out boot.har
argus net export app --reload --settle 3s --first-party --out boot.har --json
```

## Mocks

CDP Fetch interception: block, fail, stub, delay, rewrite, or act on the real response. Rules persist across reloads/reattach until removed; first match wins.

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
argus net mock add app --url "*/api/buy" --fail-after-response ConnectionReset --times 1   # server applies it, page never sees the answer
argus net mock add app --url "*/api/state" --delay-response 3s                 # forward, hold the real response
argus net mock add app --url "*/api/me" --patch-json '{"error":{"code":"AUTH"},"data":null}'   # RFC 7396 merge into real JSON
argus net mock ls app                                                           # with hit counts
argus net mock rm 2 app
argus net mock clear app
```

- `--url` is a case-insensitive wildcard over the full URL; no `*` means substring. Narrow with `--method`, `--resource-type`.
- Exactly one primary action: `--block`, `--fail <reason>`, or `--status`/`--body`/`--body-file` (+ `--header`). Without one, the rule passes the request through with optional `--delay`, `--set-header`, `--rewrite-host`.
- Response actions (`--delay-response`, `--fail-after-response`, `--patch-json`/`--patch-json-file`) forward the request first and combine with `--set-header`/`--rewrite-host`/`--delay`; `--fail-after-response` and `--patch-json` are exclusive. Only matched requests pause a second time at the response stage. `--patch-json` merges objects, `null` deletes a key, and the patched body drops `content-length`/`content-encoding`; a non-JSON body passes through unchanged and the reason shows as `error:` in `mock ls`. Redirects and network failures pass through.
- `--times N` limits any rule. `--scope page` vs `--scope selected` (`--frame` alias); without one, the watcher picks `selected` when an iframe is selected, else `page`. Selected rules follow target changes and re-arm after reload. A page rule added while an iframe is selected warns (out-of-process iframes never match it); `mock ls` shows each rule's `scope` beside `hits`.
