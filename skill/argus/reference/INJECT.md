# Script Injection on Watcher Attach

Inject custom JavaScript when the watcher attaches to a target. Runs immediately on attach and on every page navigation/reload.

## Config

```json
{
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"inject": {
				"file": "./scripts/debug-helpers.js",
				"exposeArgus": true
			}
		}
	}
}
```

| Field         | Required | Description                                                        |
| ------------- | -------- | ------------------------------------------------------------------ |
| `file`        | Yes      | Path to JavaScript file (resolved relative to config file)         |
| `exposeArgus` | No       | Set `window.__ARGUS__` metadata before script runs (default: true) |

## Timing

1. **On attach**: Script runs immediately via `Runtime.evaluate`
2. **On navigation**: Script runs at document start via `Page.addScriptToEvaluateOnNewDocument`

This ensures the script is active both when attaching to an existing page and after any reload/navigation.

## window.**ARGUS**

When `exposeArgus: true` (default), `window.__ARGUS__` is set before your script runs:

```typescript
window.__ARGUS__ = {
	watcherId: string       // e.g., "app"
	watcherHost: string     // e.g., "127.0.0.1"
	watcherPort: number     // e.g., 52341
	watcherPid: number      // Node.js process ID
	attachedAt: number      // Unix timestamp (ms)
	target: {
		title: string | null
		url: string | null
		type: string         // "page" | "iframe" | ...
		parentId: string | null
	}
}
```

Use this to conditionally enable features or communicate with the watcher.

## Use Cases

### Debug Helpers

```js
// scripts/debug-helpers.js
window.dumpState = () => console.log(JSON.stringify(window.appState, null, 2))
window.toggleDebug = () => {
	window.DEBUG = !window.DEBUG
}
```

### Error Monitoring

```js
// Wrap errors with extra context
window.onerror = (msg, src, line, col, err) => {
	console.error('[ARGUS-INJECTED]', { msg, src, line, col, stack: err?.stack })
}
```

### Global Mocks

```js
// Mock Date for deterministic testing
const fakeNow = new Date('2025-01-01T00:00:00Z').getTime()
Date.now = () => fakeNow
```

### Performance Markers

```js
// Auto-add performance marks
const origFetch = window.fetch
window.fetch = async (...args) => {
	const id = Math.random().toString(36).slice(2, 8)
	performance.mark(`fetch-start-${id}`)
	const res = await origFetch(...args)
	performance.mark(`fetch-end-${id}`)
	return res
}
```

### Conditional Debug Mode

```js
// Enable verbose logging only when Argus is attached
if (window.__ARGUS__) {
	window.DEBUG = true
	console.log(`[DEBUG] Watcher ${window.__ARGUS__.watcherId} attached`)
}
```

## CLI Usage

The inject script is typically configured via config file. The CLI reads the config and passes the script text to the watcher:

```bash
# Uses inject config from argus.config.json
argus watcher start --id app --url localhost:3000
```

## Limitations

- Script file must be readable at watcher start
- Empty scripts are skipped with a warning
- Script errors are caught and logged but don't prevent watcher attachment
- Cross-origin iframe scripts need separate injection (see [IFRAMES.md](./IFRAMES.md))

## Programmatic API

When using `@vforsh/argus-watcher` directly, pass script text (not file path):

```js
import { startWatcher } from '@vforsh/argus-watcher'
import fs from 'node:fs'

const script = fs.readFileSync('./scripts/debug.js', 'utf8')

await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
	inject: {
		script,
		exposeArgus: true,
	},
})
```
