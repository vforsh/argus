# CLI Plugins

Argus plugins are normal ESM modules loaded before Commander parses the CLI command. They can register extra top-level commands and use stable host helpers from `@vforsh/argus-plugin-api`.

## Load Sources

```bash
# Config: persistent for this workspace
argus plugin list

# Env: useful for shells/scripts
ARGUS_PLUGINS=./plugins/foo.js argus plugin list

# Dynamic: one invocation only
argus --plugin ./plugins/foo.js plugin list
```

Load order:

1. `plugins` from Argus config
2. `ARGUS_PLUGINS` comma-separated entries
3. `--plugin <module-or-path>` entries

Duplicate specifiers are loaded once, preserving first occurrence.

## Inspect

```bash
argus plugin list
argus plugin list --json
argus --plugin ./plugins/foo.js plugin list --json
```

`plugin list` reports the config path, cwd, and one entry per discovered plugin:

```json
{
	"entries": [
		{
			"source": "cli",
			"spec": "./plugins/foo.js",
			"status": "loaded",
			"name": "foo",
			"url": "file:///repo/plugins/foo.js"
		}
	]
}
```

Failures are non-fatal: Argus prints a warning and keeps registering the rest.

## Resolution

- `file:` URLs load directly.
- Relative and absolute paths resolve from config directory first, then cwd.
- Package specifiers resolve next to Argus first, then from config directory / cwd.

Use dynamic loading for local development:

```bash
npm run build --workspace @vforsh/argus-plugin-google-sheets
argus --plugin ./packages/argus-plugin-google-sheets/dist/index.js sheets read extension-3 --range A1:C5
```

## Plugin Contract

```ts
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'

const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'my-plugin',
	register(ctx) {
		ctx.program.command('mycmd').action(() => {})
	},
}

export default plugin
```

Plugins may also export the plugin as `argusPlugin`.

## Host Helpers

`ctx.host` exposes stable helpers:

- `createOutput(options)` for Argus stdout/stderr conventions
- `requestWatcherJson(input)` for watcher HTTP calls
- `writeRequestError(result, output)` for standard watcher errors
- `runChromeOpen(options)` for opening tabs through Argus Chrome resolution

## Google Sheets Plugin

```bash
argus --plugin ./packages/argus-plugin-google-sheets/dist/index.js plugin list
argus sheets read extension-3 --range A1:C5
argus sheets export extension-3 --range A1:C5 --format tsv
argus sheets find extension-3 "needle" --column ru --ignore-case
argus sheets write extension-3 B12 --value "Новое значение"
```

`sheets`/`gs` works against an attached Google Sheets tab. Reads use authenticated CSV export from inside the tab; writes select a range in the live UI and paste TSV.

## No Unload

Argus is a short-lived CLI. To unload a plugin, remove it from config/env or stop passing `--plugin` on the next invocation.
