# @vforsh/argus-client

Node-only client for the Argus watcher HTTP API: logs, network, eval, page interaction, and capture.

Built for programmatic drivers such as verification runners. The watcher is already a persistent HTTP server, so this talks to it directly — no process spawn per call, no stdout parsing.

## Install

```bash
npm install @vforsh/argus-client
```

## Usage

```ts
import { createArgusClient } from '@vforsh/argus-client'

const client = createArgusClient()

const list = await client.list()
const logs = await client.logs('app', { mode: 'preview', since: '10m', levels: ['error'] })

const baseline = await client.beginLogEpoch('app')
// perform the action under test
const actionErrors = await client.logs('app', { sinceEpoch: baseline.epoch, levels: ['error', 'exception'] })
```

Bind the watcher id once and drop it from every call site:

```ts
const page = createArgusClient().watcher('app')

await page.reload({ ignoreCache: true })
await page.evalUntil('window.app?.ready')

const rows = await page.evalValue<number>('document.querySelectorAll("tr").length')
await page.domClick({ selector: '[data-testid="submit"]' })
await page.record({ durationMs: 5_000, selector: 'canvas', outFile: 'demo.mp4' })
```

## API

### `createArgusClient(options?)`

```ts
type ArgusClientOptions = {
	registryPath?: string
	ttlMs?: number
	timeoutMs?: number
}
```

- `registryPath`: override registry path instead of `ARGUS_REGISTRY_PATH` / default.
- `ttlMs`: staleness threshold for pruning watchers (default `DEFAULT_TTL_MS`).
- `timeoutMs`: default HTTP timeout; applied as 2s for status and 5s for logs.

### `client.list(options?)`

```ts
type ListOptions = {
	byCwd?: string
}

type ListResult = {
	watcher: WatcherRecord
	reachable: boolean
	status?: StatusResponse
	error?: string
}
```

- Reads registry, prunes stale entries, pings `/status` for each watcher.
- Unreachable watchers are removed from the registry, but still returned with `reachable: false` and `error`.
- `byCwd` filters watchers by `cwd` substring (empty/whitespace treated as unset).

### `client.logs(watcherId, options?)`

```ts
type LogsOptions = {
	mode?: 'preview' | 'full'
	levels?: string | LogLevel[]
	match?: string | string[]
	matchCase?: 'sensitive' | 'insensitive'
	source?: string
	after?: LogEpoch
	sinceEpoch?: LogEpoch
	limit?: number
	since?: string | number
}

type LogsResult = {
	events: LogEvent[]
	nextCursor: LogEpoch
}
```

- `mode: 'preview'` (default) returns events with `args` bounded via `previewValue`.
- `mode: 'full'` returns raw events from the watcher.
- `levels` accepts comma-separated string or array; maps to watcher `/logs` query.
- `match` accepts regex patterns (string or array); multiple patterns use OR semantics.
- `matchCase` controls regex case-sensitivity (`insensitive` by default server-side).
- `source` filters by `LogEvent.source` substring.
- `since` accepts a duration string (e.g. `"10m"`, `"2h"`, `"30s"`) or a duration in ms.

### `client.beginLogEpoch(watcherId)`

Returns `{ epoch }` from `/logs/epoch` without downloading buffered events. Pass it as `sinceEpoch` (or `after`) for a deterministic action-scoped log read. The marker is tied to the live watcher session, not the page, so browser reloads do not reset it.

`client.logCursor(watcherId)` is the same opaque marker under the `/logs/cursor` name.

### Eval

```ts
client.eval(watcherId, options) // raw envelope: { result, type, exception }
client.evalValue<T>(watcherId, expression, options?) // the value itself; throws on page exceptions
client.evalUntil(watcherId, expression, options?) // poll until a predicate holds
```

- `eval` is unchanged: page exceptions are reported in `exception`, never thrown.
- `evalValue` returns the value directly and throws `ArgusEvalError` on a page-side exception, preferring the page's error description over CDP's bare `"Uncaught"`.
- `evalUntil` options: `intervalMs` (250), `totalTimeoutMs` (30000), `count`, `predicate`, `signal`. Rejects on timeout, exhaustion, abort, or a page exception. Resolves `{ value, iteration, elapsedMs }`.

**`jsonValue` (on by default for `evalValue`/`evalUntil`).** Transports disagree about raw `returnByValue` results: the extension relay — Chrome's `chrome.debugger` serialization — sorts object keys alphabetically at every nesting level, while a direct CDP watcher preserves insertion order. Values are identical, but structural comparisons of the same page state produce different bytes per transport, which silently breaks snapshot assertions. `jsonValue` has the page serialize the result so the JSON string crosses the transport opaquely, normalizing both to insertion order and making `Date` round-trip as an ISO string instead of `{}`.

Evaluation semantics are untouched — statement lists, top-level `await`, and REPL redeclaration behave exactly as without it. Pass `{ jsonValue: false }` for the raw transport-native value.

A watcher started before this flag existed ignores it; the client detects that and raises an actionable error rather than silently returning transport-dependent key order. Restart the watcher to pick up the current build.

### Page interaction

```ts
client.domClick(watcherId, { selector | ref | x, y, all?, button?, text?, wait? })
client.visibility(watcherId, { action: 'show' | 'hide' })
client.reload(watcherId, { ignoreCache? })
client.netClear(watcherId)
```

`visibility` locks the page shown+focused so backgrounded windows do not throttle rAF/timers. The lock is sticky across detach/reattach.

### Capture

```ts
client.screenshot(watcherId, { outFile?, selector?, clip?, format? })
client.record(watcherId, { durationMs, outFile?, selector?, clip?, fps?, format? })
client.recordStart(watcherId, options?) // -> { recordId, ... }
client.recordStop(watcherId, { recordId?, outFile? })
client.traceStart(watcherId, options?)
client.traceStop(watcherId, options?)
```

All write to disk **on the watcher host**. `selector` and `clip` are mutually exclusive. Recording is silent video, mp4 or webm, 1–60 fps.

### `client.watcher(watcherId)`

Returns the same API with `watcherId` pre-bound, minus `list`.

## Errors

- Throws on invalid inputs (`since`, `after`, `limit`) and on missing/conflicting options, before any request.
- Throws if the watcher id is not in the registry.
- If the watcher is **unreachable** (connection refused, timeout), the registry entry is removed and the call throws.
- If the watcher **answers with an error status**, the registry entry is kept: the watcher is demonstrably alive, and evicting it would break every later call in the process over one bad selector or a page mid-navigation.
- A cursor from another watcher session, a restarted watcher, or an evicted ring-buffer range is rejected; capture a new epoch.

## Notes

- `list()` and `logs()` prune stale registry entries before doing work.
- This package is Node-only and uses the Argus registry on disk.
