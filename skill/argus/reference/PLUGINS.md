# CLI Plugins

Argus plugins are normal ESM modules loaded before Commander parses the CLI command. They can register extra top-level commands and use stable host helpers from `@vforsh/argus-plugin-api`.

## Load Sources

```bash
# Global config: persistent for every workspace
argus plugin add --global foo=~/dev/foo-plugin/dist/index.js
argus foo ...

# Workspace config: persistent for this workspace
argus plugin list

# Env: useful for shells/scripts
ARGUS_PLUGINS=foo argus plugin list

# Dynamic: one invocation only
argus --plugin foo plugin list

# Config mutation
argus plugin add gsheets
argus plugin add --global foo=./plugins/foo.js
argus plugin add foo=./plugins/foo.js
argus plugin remove google-sheets
```

Load order:

1. `plugins` from per-user config at `ARGUS_HOME/config.json` (default `~/.argus/config.json`)
2. `plugins` from repo-local Argus config
3. `ARGUS_PLUGINS` comma-separated entries
4. `--plugin <module-or-path-or-alias>` entries

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
			"spec": "foo",
			"resolvedSpec": "./plugins/foo.js",
			"alias": "foo",
			"status": "loaded",
			"name": "foo",
			"version": "1.2.3",
			"description": "Foo commands for Argus",
			"commands": ["foo"],
			"homepage": null,
			"minArgusVersion": null,
			"url": "file:///repo/plugins/foo.js"
		}
	]
}
```

Failures are non-fatal: Argus prints a warning and keeps registering the rest.

## Manage Config

```bash
argus plugin add <module-or-path-or-alias>
argus plugin add <alias>=<module-or-path>
argus plugin add --global <alias>=<module-or-path>
argus plugin remove <specifier-or-name>
argus plugin remove --global <specifier-or-name>
argus plugin add ./plugins/foo.js --path argus.config.json
```

`plugin add` creates `.argus/config.json` when no workspace config exists, appends the specifier once, and preserves the rest of the config. `--global` writes `ARGUS_HOME/config.json`, so the plugin command is available from any directory without passing `--plugin`. `plugin add foo=./plugins/foo.js` writes both `plugins: ["foo"]` and `pluginAliases.foo`. `plugin remove` accepts the full specifier, alias, or package shorthand (`google-sheets` removes `gsheets` / `@vforsh/argus-plugin-google-sheets`).

## Resolution

- Built-in aliases resolve first: `gsheets` and `gs` point at `@vforsh/argus-plugin-google-sheets`.
- Config aliases in `pluginAliases` override built-ins.
- `file:` URLs load directly.
- `~`, relative, and absolute paths resolve from the owning config directory first, then other discovered config directories, then cwd.
- Package specifiers resolve next to Argus first, then from config directory / cwd.

Use dynamic loading for local development:

```bash
bun run --cwd ~/dev/argus-google-sheets-plugin build
argus --plugin ~/dev/argus-google-sheets-plugin/dist/index.js sheets read extension-3 --range A1:C5
argus --plugin gs sheets read extension-3 --range A1:C5
```

## Plugin Contract

```ts
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'

const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'my-plugin',
	version: '1.0.0',
	description: 'Short human description.',
	commands: ['mycmd'],
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
- `defineWatcherCommand(spec)` for stable watcher-backed command runners with JSON/human formatting
- `argus.eval`, `argus.dom.click/drag/info/keydown`, and `argus.screenshot` for common watcher calls without raw paths

Minimal watcher command:

```ts
ctx.program
	.command('title [id]')
	.option('--json')
	.action(
		ctx.host.defineWatcherCommand({
			build: () => ({ path: '/eval', method: 'POST', body: { expression: 'document.title', returnByValue: true } }),
			formatHuman: (response: { ok: true; result: unknown }, { output }) => output.writeHuman(String(response.result ?? '')),
		}),
	)
```

## Google Sheets Plugin

`@vforsh/argus-plugin-google-sheets` (aliases `gsheets`, `gs`) ships as a separate package. Command reference, safety flow, and manifest schema live in its own repo (`~/dev/argus-google-sheets-plugin`): `skill/argus-sheets/SKILL.md` and the package README.

```bash
argus plugin add --global gsheets
argus sheets --help
```

## No Unload

Argus is a short-lived CLI. To unload a plugin, remove it from config/env or stop passing `--plugin` on the next invocation.
