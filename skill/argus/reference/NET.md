## Network Commands

Use this after a watcher is attached and you need request summaries, fresh capture windows, request/response bodies, WebSockets, SSE, HAR export, or network mocking.

For iframe-active extension watchers, choose scope deliberately:

- `--scope selected` / `--frame selected` means traffic for the selected iframe target.
- page/tab scope means traffic for the top page.
- reload-driven `net watch`, `net export`, and `net inspect` reject selected-frame scope because reloading an iframe target is ambiguous.

## Quick Read

```bash
argus net app --since 5m
argus net app --grep api
argus net app --json
argus net tail app --grep api --json
argus net summary app
argus net clear app
```

`net clear` resets the watcher buffer so the next inspection starts clean.

## Fresh Capture

```bash
argus net watch app --reload --settle 3s
argus net watch app --reload --settle-after "window.appReady" --settle 2s
argus net watch app --reload --settle 3s --ignore-pattern /poll
argus net watch app --reload --settle 3s --max-timeout 30s
```

`net watch` tails matching requests until no new matches arrive for `--settle`. `--settle-after "<expr>"` polls the page first, then starts the quiet-window countdown only after the expression becomes truthy.

## Inspect One Endpoint

```bash
argus net inspect /api/init app --reload
argus net inspect /api/post app --settle-after "window.appReady" --settle 400ms
argus net inspect /api/init app --reload --request --response
```

`net inspect` captures a fresh window, picks the newest URL match, prints a compact request summary, and can include request/response bodies.

## Filters

```bash
argus net extension --scope selected --host game-frame-host.example --resource-type Fetch
argus net extension --first-party --slow-over 500ms --status 4xx
argus net extension --large-over 100kb --mime application/json
argus net app --method POST --host api.example.com
argus net app --failed-only
argus net app --domain example.com
```

Common filters: host, domain, method, status/status class (`2xx`), resource type, MIME prefix, first-party/third-party, failed-only, slow-over, large-over, and scope/frame.

## Show And Bodies

```bash
argus net show 42 app
argus net show 90829.507 extension --json
argus net body 42 app
argus net body 42 app --request
```

`net show` drills into one buffered request by Argus id or raw CDP request id, including redacted headers, initiator, redirect chain, cache/service-worker flags, timing phases, and body availability. `net body` lazily fetches response body by default; add `--request` for request body.

## Export / WebSockets / SSE

```bash
argus net export app --out boot.har
argus net export app --reload --settle 3s --out boot.har
argus net ws app
argus net ws show 1 app
argus net sse app
```

`net export --format har` writes the current buffer or a fresh reload capture as HAR. `net ws show` prints WebSocket handshake headers plus bounded recent frame previews. `net sse` lists EventSource/text-event-stream requests at request level; CDP does not reliably expose SSE event payloads.

## Network Mocking

Intercept live requests via CDP Fetch: block, fail with a real network error, stub responses, inject latency, or rewrite requests.

```bash
argus net mock add app --url "*/analytics/*" --block
argus net mock add app --url "*/api/save" --fail ConnectionRefused
argus net mock add app --url "*/api/init" --fail TimedOut --times 1
argus net mock add app --url "*/api/config" --status 200 --body-file ./fixtures/config.json
argus net mock add app --url "*/api/config" --status 500 --body '{"error":"maintenance"}'
echo '{"flags":{"newShop":true}}' | argus net mock add app --url "*/api/flags" --body -
argus net mock add app --url "*/api/*" --delay 2s --method POST
argus net mock add app --url "*/api/*" --set-header "x-debug: 1"
argus net mock add app --url "cdn.prod.com" --rewrite-host localhost:3000
argus net mock ls app
argus net mock rm 2 app
argus net mock clear app
```

Rules persist across reloads and reattach until removed. First matching rule wins. `--url` is a case-insensitive wildcard pattern over the full request URL; `*` matches anything, and no `*` means substring match. Use `--times N` for one-shot failures.

Exactly one primary action per rule:

- `--block` aborts as `BlockedByClient`.
- `--fail <reason>` aborts with a CDP network error such as `TimedOut` or `ConnectionRefused`.
- `--status` with `--body`, `--body-file`, and optional headers stubs a response.

Without a primary action, rules pass requests through with optional latency, request-header changes, or host/origin rewrites.
