# Script Injection

Two mechanisms: runtime **init scripts** (`page init-script`, add/remove while the watcher runs) and the startup **`--inject`** hook (fixed for the watcher's lifetime).

## Init Scripts

Run before any page script in every new document, kept by the watcher across reloads, navigations, and reattach (tab replaced, Android app restarted) until removed. Use them to install spies/wrappers before the app captures globals, or to seed state for the page's very first requests.

```bash
argus page init-script add app --file ./fixtures/spy-fetch.js       # name defaults to the file name
argus page init-script add app "localStorage.setItem('debug','1')"
argus page init-script add app --file ./hooks.js --run-now          # also run in the current document
cat hooks.js | argus page init-script add app --stdin
argus page init-script ls app                                       # id, name, size, registered
argus page init-script rm 1 app
argus page init-script clear app
```

- Scripts run in add order as classic scripts (`Page.addScriptToEvaluateOnNewDocument`); top-level `let`/`const` share the global scope, so wrap code in an IIFE when several scripts declare the same names.
- Registration only affects documents created afterwards. `--run-now` also runs it in the already loaded document, once, at add time; it is not repeated on reattach. After a reattach the current document already ran its scripts, so reload to get the init scripts in.
- `rm`/`clear` affect future documents only; patched globals stay in the current one.
- Registered on the watcher's page target; out-of-process iframes need their own watcher.
- Need a counter ("only the first N loads")? Keep it in the script itself, e.g. via `sessionStorage`.

## Startup `--inject`

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

### Timing

1. On attach: `Runtime.evaluate` immediately.
2. On navigation: `Page.addScriptToEvaluateOnNewDocument`, so the script is present before page code runs.

### `window.__ARGUS__`

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

### Typical Scripts

```js
// helpers callable from `argus eval`
window.dumpState = () => JSON.stringify(window.appState, null, 2)

// deterministic time
const fakeNow = new Date('2025-01-01T00:00:00Z').getTime()
Date.now = () => fakeNow

// error context
window.onerror = (msg, src, line, col, err) => console.error('[ARGUS]', { msg, src, line, col, stack: err?.stack })
```

### Notes

- File must be readable at watcher start; empty scripts are skipped with a warning; script errors are logged and do not block attach.
- Cross-origin iframe targets need their own watcher/injection ([IFRAMES.md](./IFRAMES.md)).
- One-off injection into an already attached page: `argus dom add-script app --file ./x.js` or `argus eval app --inject ./x.js "…"` ([DOM.md](./DOM.md), [EVAL.md](./EVAL.md)).
