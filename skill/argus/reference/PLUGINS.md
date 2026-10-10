# CLI Plugins

Plugins are ESM modules loaded before Commander parses argv. They add top-level commands (site-specific drivers, company tooling) and use stable host helpers from `@vforsh/argus-plugin-api`. Installed plugins show up in `argus --help`; each ships its own docs/skill.

## Load And Manage

```bash
argus plugin list [--json]                          # what this invocation discovered, with status/commands
argus --plugin ./plugins/foo.js foo …               # one invocation only
ARGUS_PLUGINS=foo,./plugins/bar.js argus plugin list   # env, comma-separated
argus plugin add gsheets                            # workspace config (.argus/config.json, created if missing)
argus plugin add foo=./plugins/foo.js               # alias + path (writes plugins[] and pluginAliases.foo)
argus plugin add --global clogs=~/dev/argus-clogs-plugin/dist/index.js   # per-user: $ARGUS_HOME/config.json
argus plugin add ./plugins/foo.js --path argus.config.json
argus plugin remove google-sheets                   # by specifier, alias, or package shorthand; --global for user config
```

Load order (canonical modules loaded once, source provenance retained): per-user config → repo config → `ARGUS_PLUGINS` → `--plugin`. A plugin that fails to load prints a warning; the rest still register. No unload: remove it from config/env or drop `--plugin`.

Resolution: built-in aliases (`gsheets`, `gs` → `@vforsh/argus-plugin-google-sheets`) and config aliases resolve against the config that owns them. Paths/file URLs are canonicalized through realpath before deduplication; CLI/env paths use cwd. Packages resolve from the owning config/cwd before the Argus installation fallback. Distinct modules with the same plugin name fail with a conflict diagnostic.

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
		ctx.program
			.command('mycmd title [id]')
			.option('--json')
			.action(
				ctx.host.defineWatcherCommand({
					build: () => ({ path: '/eval', method: 'POST', body: { expression: 'document.title', returnByValue: true } }),
					formatHuman: (response: { ok: true; result: unknown }, { output }) => output.writeHuman(String(response.result ?? '')),
				}),
			)
	},
}

export default plugin // or: export const argusPlugin = plugin
```

`ctx.host` helpers: `createOutput` (stdout/stderr conventions, `--json`), `requestWatcherJson` (typed watcher HTTP), `writeRequestError`, `runChromeOpen`, `defineWatcherCommand` (watcher-backed command with JSON/human formatting), and `argus.eval` / `argus.dom.click|drag|info|keydown` / `argus.screenshot` shortcuts.

Local development: build the plugin, then `argus --plugin ~/dev/my-plugin/dist/index.js mycmd …`.

## Lazy Registration

Publish an `argusPlugin` JSON object in the nearest package.json above the resolved entry, or write `<entry>.argus-plugin.json`. Sidecar wins; metadata is reread on each invocation, with no persistent cache.

```json
{ "apiVersion": 1, "name": "my-plugin", "commands": ["mycmd", "mc"], "eager": false }
```

`commands` must exhaustively list top-level names and aliases. `eager: false` promises independent, additive command registration: no changes to existing commands, root options/hooks, or global state needed by unrelated commands. Argus stages registration on a separate Commander tree, checks advertised names/aliases and command ownership, then attaches the tree atomically. Failed registration exposes no executable commands. This is command-tree isolation, not a JavaScript sandbox. Argus imports only matching plugins. Root help and `plugin list` initialize all, giving accurate dynamic help and load failures. Sessions prepare plugin commands on first request and reuse registrations; restart the session to discover edits.

Legacy v1 plugins, missing/invalid manifests, and `eager: true` retain unrestricted eager registration. The module's existing exported `commands` field remains descriptive and is never assumed complete. `apiVersion` and `minArgusVersion` are checked before registration (including manifest-only discovery); minimum versions are semantic version floors, not ranges. Unsupported requirements fail with upgrade guidance. Optional manifest metadata: `version`, `description`, `homepage`, `minArgusVersion`; `plugin list` reports the actual module metadata and registration status.

Built-in actions also load on demand from ESM chunks. Copy the entire published `dist` directory. Bare `argus --version` / `argus -V` reads only the CLI version and bypasses config and all plugins.

Plugin command actions report failures with `ctx.host.setExitCode(code)` so a timed-out session action cannot contaminate another request. Use `ctx.host.watcherArgument(command)` to declare a leading watcher positional explicitly; sessions inject the pinned watcher regardless of its argument name (legacy leading `id` remains supported).

`ctx.host.getRequestContext()` exposes the current request's absolute deadline and abort signal. Watcher requests also accept `signal`, `deadline`, and a `mutation` identity. The host bounds HTTP and browser budgets and records mutation identity at dispatch. Lost mutation acknowledgements must be treated as uncertain: inspect state/status before explicitly retrying. `requestWatcherJson` failures preserve `code`, `failureKind`, HTTP `status`, a bounded technical `cause`, and `dispatched`.
