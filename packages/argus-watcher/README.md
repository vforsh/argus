# argus-watcher

Library for starting a watcher that connects to Chrome DevTools Protocol (CDP), buffers console logs, and exposes an HTTP API on `127.0.0.1`.

## Usage

```js
import { startWatcher } from '@vforsh/argus-watcher'

const watcher = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
  chrome: { host: '127.0.0.1', port: 9222 },
  fileLogs: { logsDir: '/tmp/argus/watcher-logs' },
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
- `fileLogs`: optional persistence for watcher logs
    - `logsDir`: directory for log files (required)
    - `maxFiles`: max log files to keep for the session (default `5`)
    - Rotation: a new file is created after each top-level navigation/reload (lazy; created on first log)
- `ignoreList`: optional ignore list filtering when selecting log/exception locations
    - `enabled`: enable ignore list selection (default `false`)
    - `rules`: regex patterns (as strings) to ignore (merged with built-in defaults)
- `location`: optional display cleanup settings
    - `stripUrlPrefixes`: literal URL prefixes to remove from `event.file` for display

## File logs

File logging is opt-in via `fileLogs`. When enabled, logs are written to `.log` files under the provided `logsDir`.

Behavior details:

- Lazy creation: no file is created until the first log arrives after start or after a rotation.
- Rotation trigger: each top-level navigation or reload rotates to a new file.
- File naming: `watcher-<watcherId>-<startedAtIso>-<n>.log` (n starts at 1).
- Retention: after a new file is created, older files are deleted to keep at most `maxFiles`.
- Session header: each file starts with a short header containing watcher id, start time, host/os/arch, cwd, logs path, chrome host/port, match, page URL/title, and page timezone/locale.
- Log lines: one log event per line with ISO timestamp and level; includes location when available and page URL when it changes.
