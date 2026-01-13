# argus-watcher

Library for starting a watcher that connects to Chrome DevTools Protocol (CDP), buffers console logs, and exposes an HTTP API on `127.0.0.1`.

## Usage

```js
import { startWatcher } from '@vforsh/argus-watcher'

const watcher = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
	artifacts: {
		base: '/tmp/argus/artifacts',
		logs: { enabled: true },
	},
	ignoreList: {
		enabled: true,
		rules: ['webpack:///node_modules/'],
	},
	location: {
		stripUrlPrefixes: ['http://127.0.0.1:3000/'],
	},
})

// later
await watcher.close()
```

## API

`startWatcher(options)`

- `id` (required): registry id
- `host`/`port`: bind address (defaults to `127.0.0.1`, random port)
- `match`: URL/title matching for CDP target selection
- `chrome`: CDP host/port (defaults to `127.0.0.1:9222`)
- `bufferSize`: max in-memory log count (default `50000`)
- `artifacts`: optional artifact storage configuration
    - `base`: base directory for all artifacts (default `<cwd>/argus-artifacts`)
    - `logs`: file log settings (disabled by default)
        - `enabled`: enable file logging (default `false`)
        - `includeTimestamps`: include ISO timestamps in log records (default `false`)
        - `maxFiles`: max log files to keep per session (default `5`)
        - `buildFilename`: optional callback to customize log filenames
    - `traces`: trace recording settings
        - `enabled`: enable trace recording (default `true`)
    - `screenshots`: screenshot capture settings
        - `enabled`: enable screenshot capture (default `true`)
- `net`: network request capture configuration (disabled by default)
    - `enabled`: enable network capture and `/net` endpoints (default `false`)
- `ignoreList`: optional ignore list filtering when selecting log/exception locations
    - `enabled`: enable ignore list selection (default `false`)
    - `rules`: regex patterns (as strings) to ignore (merged with built-in defaults)
- `location`: optional display cleanup settings
    - `stripUrlPrefixes`: literal URL prefixes to remove from `event.file` for display
- `pageIndicator`: optional in-page indicator showing watcher attachment (opt-in)
    - `enabled`: enable the indicator (default `false`)
    - `position`: `'left'` | `'center'` | `'right'` (default `'left'`, at bottom of page)
    - `heartbeatMs`: how often Node pings the page (default `2000`)
    - `ttlMs`: how long the page keeps the indicator without pings (default `6000`)

## Directory layout

All artifacts are stored under `artifacts.base` (default: `<cwd>/argus-artifacts`):

```
argus-artifacts/
├── logs/           # File logs (when artifacts.logs.enabled=true)
├── traces/         # Trace recordings
└── screenshots/    # Screenshots
```

## Events

The `WatcherHandle` returned by `startWatcher` includes an `events` property which is an [Emittery](https://github.com/sindresorhus/emittery) instance.

```js
const { watcher, events } = await startWatcher(...)

events.on('cdpAttached', ({ target }) => {
  console.log(`Attached to ${target.title}`)
})

events.on('cdpDetached', ({ reason }) => {
  console.log(`Detached: ${reason}`)
})

events.on('httpRequested', ({ endpoint, query }) => {
  console.log(`Client requested ${endpoint} with params ${JSON.stringify(query)}`)
})
```

## File logs

File logging is opt-in via `artifacts.logs.enabled`. When enabled, logs are written to `.log` files under `<artifacts.base>/logs/`.

Behavior details:

- Lazy creation: no file is created until the first log arrives after start or after a rotation.
- Rotation trigger: each top-level navigation or reload rotates to a new file.
- File naming: `watcher-<watcherId>-<startedAtIso>-<n>.log` (n starts at 1).
- Retention: after a new file is created, older files are deleted to keep at most `maxFiles`.
- Session header: each file starts with a short header containing watcher id, start time, host/os/arch, cwd, logs path, chrome host/port, match, page URL/title, and page timezone/locale.
- Log lines: one log event per line with ISO timestamp and level; includes location when available and page URL when it changes.

## Network capture

Network request capture is opt-in via `net.enabled`. When disabled (default), the `/net` and `/net/tail` HTTP endpoints return a `net_disabled` error.
