# Programmatic watcher (Node API)

Use `@vforsh/argus-watcher` when you want to create/start watchers from code (tests, scripts, custom tooling) instead of running `argus watcher start`.

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	// Same concept as `argus watcher start --id <id>`
	id: 'app',

	// Same concept as `--url` matching (controls which pages to attach to)
	match: { url: 'localhost:3000' },

	// CDP endpoint for the already-running Chrome instance
	chrome: { host: '127.0.0.1', port: 9222 },

	// Optional: persist artifacts (logs/traces/screenshots)
	artifacts: {
		base: '/tmp/argus/artifacts',
		logs: { enabled: true },
	},

	// Optional knobs:
	// bufferSize, host/port (bind), net, ignoreList, location, pageIndicator, ...
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title ?? '(unknown)'}`)
})

// later
await close()
```

For the full `startWatcher(options)` surface (and the `WatcherHandle.events` emitter), see `packages/argus-watcher/README.md`.
