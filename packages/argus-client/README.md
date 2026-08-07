# @vforsh/argus-client

Node-only client for Argus watcher list/logs APIs.

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

## Errors

- Throws on invalid inputs (`since`, `after`, `limit`).
- Throws if the watcher id is not in the registry.
- If the watcher is unreachable, the registry entry is removed and the call throws.
- A cursor from another watcher session, a restarted watcher, or an evicted ring-buffer range is rejected; capture a new epoch.

## Notes

- `list()` and `logs()` prune stale registry entries before doing work.
- This package is Node-only and uses the Argus registry on disk.
