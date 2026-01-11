# argus-watcher

Library for starting a watcher that connects to Chrome DevTools Protocol (CDP), buffers console logs, and exposes an HTTP API on `127.0.0.1`.

## Usage

```js
import { startWatcher } from '@vforsh/argus-watcher'

const watcher = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
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
