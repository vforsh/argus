# Launch And Lifecycle (CDP)

CDP mode: Argus launches (or connects to) a Chrome with remote debugging and a watcher attaches to one target. Use extension-control instead when the task needs the user's real profile ([EXTENSION.md](./EXTENSION.md)).

`start`, `chrome start`, `watcher start`, and `page open --attach` stay in the foreground until Ctrl+C. Background them in agent shells.

## `argus start` (Chrome + watcher)

```bash
argus start --id app --url localhost:3000
argus start --id app --url localhost:3000 --headless --profile temp
argus start --id app --url https://example.com --headless --user-agent regular-chrome
argus start --id app --url localhost:3000 --dev-tools --no-mute
argus start --id app --url localhost:3000 --inject ./debug.js --no-page-indicator
argus start --id app --auth-from ext-2                         # clone login from another watcher
argus start --id app --auth-from ext-2 --url https://target.app/
argus start --id game --type iframe --url localhost:3007
argus start --id app --url localhost:3000 --json
```

Chrome flags: `--profile`, `--dev-tools`, `--headless`, `--user-agent`, `--no-mute`. `--user-agent regular-chrome` derives Chrome's own UA and removes only the headless marker before the first navigation; a literal value is passed through unchanged. Watcher flags: `--type`, `--origin`, `--target`, `--parent`, `--inject`, `--artifacts`, `--no-page-indicator`. `--auth-from` hydrates cookies + storage from a running watcher into a fresh temp profile before attaching; `--url` then overrides the final destination.

## `argus chrome`

```bash
argus chrome start --url http://localhost:3000
argus chrome start --from-watcher app          # reuse a registered watcher's match URL
argus chrome start --profile temp --headless
argus chrome start --url https://example.com --headless --user-agent regular-chrome
argus chrome start --auth-state ./auth.json    # hydrate exported state (forces temp profile)
argus chrome ls --pages
argus chrome status --cdp 127.0.0.1:9222
argus chrome version --id app
argus chrome stop --id app
```

Profile modes (`--profile`, default `default-lite`):

| Mode             | Contents                                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| `temp`           | Empty fresh profile                                                            |
| `default-lite`   | Temp copy of the user's Cookies, Login Data, Preferences (extensions stripped) |
| `default-medium` | `default-lite` + History, Local Storage, IndexedDB                             |
| `default-full`   | Full copy of the `Default` profile dir                                         |

User data dir is auto-detected; override with `ARGUS_CHROME_USER_DATA_DIR`. Chrome binary: `ARGUS_CHROME_BIN` if auto-detection fails. Chrome starts muted unless `--no-mute`.

Headless authenticated session when the site stores auth outside cookies:

```bash
argus start --id app --url https://example.com --headless \
  --profile default-medium --user-agent regular-chrome
```

`default-medium` carries cookies plus Local Storage and IndexedDB into the isolated profile. The startup UA flag is applied before the first document request, so no preliminary `HeadlessChrome` navigation reaches the site.

## `argus watcher`

```bash
argus watcher start --id app --url localhost:3000 --chrome-port 9222
argus watcher start --url localhost:3000                         # auto-generated id
argus watcher start --id game --type iframe --url localhost:3007
argus watcher start --id game --origin https://localhost:3007    # protocol+host+port, ignores query
argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344
argus watcher start --id game --type iframe --parent yandex.ru
argus watcher start --id app --source extension                  # extension-backed (normally via `ext use`)
argus watcher status app
argus watcher ls --by-cwd my-project
argus watcher stop app
argus watcher prune --dry-run                                    # drop unreachable registry entries
argus watcher show app / hide app                                # alias of `page show/hide`
```

Target matching: `--url` substring, `--origin` exact origin, `--target` exact Chrome target id, `--type page|iframe|worker`, `--parent` substring of the parent target URL. Combine `--type iframe --url …` when the host page carries the iframe URL in its query string ([IFRAMES.md](./IFRAMES.md)). Default artifacts dir: `$TMPDIR/argus`.

## Open a tab and attach by target id

```bash
argus page open --url http://localhost:3000 --attach --as app    # CDP only; foreground like `start`
argus page open --url http://example.com                         # just opens, prints target, exits
```

`--attach` matches the new tab by **target id**, so a second tab with the same URL cannot be picked.

## Diagnostics

```bash
argus list                 # watchers + Chrome instances
argus doctor --json        # environment checks
argus watcher status app
argus chrome status --id app
```

## Config Defaults

Auto-discovered from cwd: `.argus/config.json`, `.config/argus.json`, `argus.config.json`, `argus/config.json`. `argus config init [--path …] [--force]` writes a starter. CLI flags override config; `--config <path>` picks a file explicitly.

```json
{
	"chrome": { "start": { "url": "http://localhost:3000", "devTools": true, "userAgent": "regular-chrome" } },
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"inject": { "file": "./scripts/debug.js" }
		}
	},
	"plugins": ["gsheets"]
}
```

Per-user config lives at `$ARGUS_HOME/config.json` (default `~/.argus/config.json`) and is used for global plugins ([PLUGINS.md](./PLUGINS.md)).

## Node API

`@vforsh/argus-watcher` exports `startWatcher(options) → { watcher, events, close }`. Events: `cdpAttached`, `cdpDetached`, `httpRequested`. Full runnable example with env-driven options: [start-watcher.ts](../start-watcher.ts).

```ts
import { startWatcher } from '@vforsh/argus-watcher'

const { watcher, events, close } = await startWatcher({
	id: 'app',
	match: { url: 'localhost:3000' },
	chrome: { host: '127.0.0.1', port: 9222 },
	inject: { script: 'window.DEBUG = true', exposeArgus: true },
})
events.on('cdpAttached', ({ target }) => console.log('attached', target?.url))
await close()
```

Callers that skip the CLI (SDK, raw HTTP) must pass absolute `--out` paths; relative ones resolve under the watcher's temp artifacts dir.
