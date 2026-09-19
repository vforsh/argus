# Script Injection

Run your own JavaScript when the watcher attaches and again at document start after every navigation/reload. Wired through `start`, `watcher start`, config, and the Node API. Tab watchers created by `argus ext use` have no inject hook; use `dom add-script` or `eval --inject` there.

```bash
argus start --id app --url localhost:3000 --inject ./scripts/debug-helpers.js
argus watcher start --id app --url localhost:3000 --inject ./scripts/debug-helpers.js
```

Config (`inject.file` is resolved relative to the config file):

```json
{
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"inject": { "file": "./scripts/debug-helpers.js", "exposeArgus": true }
		}
	}
}
```

Node API takes script **text**, not a path: `startWatcher({ …, inject: { script, exposeArgus: true } })`.

## Timing

1. On attach: `Runtime.evaluate` immediately.
2. On navigation: `Page.addScriptToEvaluateOnNewDocument`, so the script is present before page code runs.

## `window.__ARGUS__`

Set before the script runs when `exposeArgus` is true (default):

```ts
window.__ARGUS__ = {
	watcherId: string
	watcherHost: string
	watcherPort: number
	watcherPid: number
	attachedAt: number          // ms epoch
	target: { title: string | null; url: string | null; type: string; parentId: string | null }
}
```

Use it to gate debug behavior: `if (window.__ARGUS__) window.DEBUG = true`.

## Typical Scripts

```js
// helpers callable from `argus eval`
window.dumpState = () => JSON.stringify(window.appState, null, 2)

// deterministic time
const fakeNow = new Date('2025-01-01T00:00:00Z').getTime()
Date.now = () => fakeNow

// error context
window.onerror = (msg, src, line, col, err) => console.error('[ARGUS]', { msg, src, line, col, stack: err?.stack })
```

## Notes

- File must be readable at watcher start; empty scripts are skipped with a warning; script errors are logged and do not block attach.
- Cross-origin iframe targets need their own watcher/injection ([IFRAMES.md](./IFRAMES.md)).
- One-off injection into an already attached page: `argus dom add-script app --file ./x.js` or `argus eval app --inject ./x.js "…"` ([DOM.md](./DOM.md), [EVAL.md](./EVAL.md)).
