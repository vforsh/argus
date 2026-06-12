## Start And Watcher Lifecycle

Use CDP startup when an isolated/debuggable Chrome is acceptable. Use extension-control instead when the task needs the user's normal browser profile, cookies, local storage, saved logins, or already-open tabs.

Long-running commands must run in the background in agent shells:

- `argus start`
- `argus chrome start`
- `argus watcher start`
- `argus logs tail`
- `argus net tail`

## Start (Chrome + Watcher)

```bash
argus start --id app --url localhost:3000
argus start --id app --auth-from extension-2
argus start --id app --auth-from extension-2 --url https://target.app/
argus start --id app --url localhost:3000 --dev-tools
argus start --id app --url localhost:3000 --profile temp
argus start --id app --type page --headless
argus start --id app --url localhost:3000 --inject ./debug.js
argus start --id app --url localhost:3000 --no-page-indicator
argus start --id app --url localhost:3000 --json
```

`--url` opens in Chrome and matches the watcher target. `--auth-from` clones cookies and storage from another watcher into a fresh temp Chrome session before attach; add `--url` to override the final destination after hydration. `argus start` accepts Chrome options (`--profile`, `--dev-tools`, `--headless`) and watcher options (`--type`, `--origin`, `--target`, `--parent`, `--inject`, `--artifacts`, `--no-page-indicator`).

## Chrome Start

```bash
argus chrome start --url http://localhost:3000
argus chrome start --from-watcher app
argus chrome start --dev-tools
argus chrome start --headless
argus chrome start --auth-state auth.json
```

`--from-watcher` reads the URL from a registered watcher config. `--auth-state` hydrates cookies/storage into a fresh Chrome profile before opening the page.

## Watcher Start

```bash
argus watcher start --id app --url localhost:3000
argus watcher start --id app --url localhost:3000 --chrome-port 9222
argus watcher start --id app --type iframe --url localhost:3007
argus watcher start --id app --type iframe --parent example.com
argus watcher start --id app --origin https://localhost:3007
argus watcher start --id app --target CC1135709D9AC3B9CC0446F8B58CC344
argus watcher start --id app --url localhost:3000 --inject ./debug.js
argus watcher start --id app --url localhost:3000 --no-page-indicator
argus watcher start --id app --source extension
```

`--url` matches a target URL substring. `--origin` matches protocol+host+port. `--target` connects to a specific Chrome target id. `--type` filters target type (`page`, `iframe`, `worker`). `--parent` filters by parent target URL. `--inject` runs a JS file on attach and navigation. `--no-page-indicator` hides the in-page overlay, useful before screenshots.

## Targets / Pages

```bash
argus page ls --id app
argus page ls --type iframe --id app
argus page ls --tree --id app
argus page open --url http://example.com --id app
argus page reload --id app
argus page reload <targetId> --param foo=bar
argus page activate <targetId>
argus page close <targetId>
argus reload app
argus reload app --ignore-cache
```

## Config Defaults

Load defaults for `argus start`, `argus chrome start`, and `argus watcher start` from config files.

Auto-discovery:

- `.argus/config.json`
- `.config/argus.json`
- `argus.config.json`
- `argus/config.json`

```json
{
	"chrome": {
		"start": { "url": "http://localhost:3000", "devTools": true }
	},
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"inject": { "file": "./scripts/debug.js" }
		}
	}
}
```

CLI flags override config. `argus config init` creates a starter config. Script injection runs custom JS on attach and page navigation; see [INJECT.md](./INJECT.md).

## Programmatic Watcher (Node API)

Use `@vforsh/argus-watcher` to create watchers from code.

```js
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
})

events.on('cdpAttached', ({ target }) => {
	console.log(`Attached to ${target?.title}`)
})

await close()
```
