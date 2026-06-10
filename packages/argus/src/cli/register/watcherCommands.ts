import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runList } from '../../commands/list.js'
import { runReload } from '../../commands/reload.js'
import { runPageShow, runPageHide } from '../../commands/pageVisibility.js'
import { runWatcherStart } from '../../commands/watcherStart.js'
import { runWatcherStatus } from '../../commands/watcherStatus.js'
import { runWatcherStop } from '../../commands/watcherStop.js'
import { runWatcherPrune } from '../../commands/watcherPrune.js'
import { runWatcherNativeHost } from '../../commands/watcherNativeHost.js'
import { loadArgusConfig, resolveArgusConfigPath } from '../../config/loadConfig.js'
import { mergeWatcherStartOptionsWithConfig } from '../../config/mergeConfig.js'

export const watcherCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'watcher',
		alias: 'watchers',
		description: 'Watcher management commands',
		subcommands: [
			{
				name: 'start',
				alias: 'attach',
				description: 'Start an Argus watcher process',
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to announce in the registry (auto-generated if omitted)' },
					{ flags: '--source <mode>', description: 'Source mode: cdp (default) or extension' },
					{ flags: '--url <url>', description: 'URL pattern to match for capturing logs (CDP mode only)' },
					{ flags: '--type <type>', description: 'Filter by target type (e.g., page, iframe, worker) (CDP mode only)' },
					{ flags: '--origin <origin>', description: 'Match against URL origin only (protocol + host + port) (CDP mode only)' },
					{ flags: '--target <targetId>', description: 'Connect to a specific target by its Chrome target ID (CDP mode only)' },
					{ flags: '--parent <pattern>', description: 'Filter by parent target URL pattern (CDP mode only)' },
					{ flags: '--chrome-host <host>', description: 'Chrome CDP host (default: 127.0.0.1) (CDP mode only)' },
					{ flags: '--chrome-port <port>', description: 'Chrome CDP port (default: 9222) (CDP mode only)' },
					{ flags: '--artifacts <dir>', description: 'Artifacts base directory (default: $TMPDIR/argus)' },
					{ flags: '--no-page-indicator', description: 'Disable the in-page watcher indicator' },
					{ flags: '--inject <path>', description: 'Path to JavaScript file to inject on watcher attach' },
					{ flags: '--config <path>', description: 'Path to Argus config file' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus watcher start --url localhost:3000              # auto-generated id',
					'argus watcher start --id app --url localhost:3000',
					'argus watcher start --id app --source extension',
					'argus watcher start --id game --type iframe --url localhost:3007',
					'argus watcher start --id game --origin https://localhost:3007',
					'argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344',
					'argus watcher start --id game --type iframe --parent yandex.ru',
					'argus watcher start --id app --url localhost:3000 --no-page-indicator',
					'argus watcher start --id app --url localhost:3000 --inject ./scripts/debug.js',
					'argus watcher start --id app --url localhost:3000 --json',
					'argus watcher attach --id app --url localhost:3000',
				],
				action: async (options, command) => {
					const { config: configPath, inject, ...rest } = options
					const cliOptions = {
						...rest,
						inject: inject ? { file: inject } : undefined,
					}
					const resolvedPath = resolveArgusConfigPath({ cliPath: configPath, cwd: process.cwd() })
					if (!resolvedPath) {
						if (configPath) {
							return
						}
						await runWatcherStart(cliOptions)
						return
					}

					const configResult = loadArgusConfig(resolvedPath)
					if (!configResult) {
						return
					}

					const merged = mergeWatcherStartOptionsWithConfig(cliOptions, command, configResult)
					if (!merged) {
						return
					}

					await runWatcherStart(merged)
				},
			},
			{
				name: 'stop',
				alias: 'kill',
				aliases: ['detach'],
				description: 'Stop a watcher',
				arguments: [{ flags: '[id]', description: 'Watcher id to stop' }],
				options: [{ flags: '--id <watcherId>', description: 'Watcher id to stop' }],
				examples: ['argus watcher stop app', 'argus watcher stop --id app', 'argus watcher kill app', 'argus watcher detach app'],
				action: async (id, options) => {
					await runWatcherStop(id ?? options.id, options)
				},
			},
			{
				name: 'status',
				alias: 'ping',
				description: 'Check watcher status',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [{ flags: '--json', description: 'Output JSON for automation' }],
				examples: ['argus watcher status app', 'argus watcher status app --json'],
				action: async (id, options) => {
					await runWatcherStatus(id, options)
				},
			},
			{
				name: 'ls',
				alias: 'list',
				description: 'List registered watchers',
				options: [
					{ flags: '--json', description: 'Output JSON for automation' },
					{ flags: '--by-cwd <substring>', description: 'Filter watchers by working directory substring' },
				],
				examples: ['argus watcher ls', 'argus watcher ls --json', 'argus watcher ls --by-cwd my-project'],
				action: async (options) => {
					await runList(options)
				},
			},
			{
				name: 'reload',
				description: 'Reload the page attached to a watcher',
				arguments: [{ flags: '[id]', description: 'Watcher id to reload' }],
				options: [
					{ flags: '--ignore-cache', description: 'Bypass browser cache' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: ['argus watcher reload app', 'argus watcher reload app --ignore-cache', 'argus watcher reload app --json'],
				action: async (id, options) => {
					await runReload(id, options)
				},
			},
			{
				name: 'show',
				description: "Lock the watcher's attached page as shown+focused (alias for `argus page show`)",
				arguments: [{ flags: '[id]', description: 'Watcher id whose page to lock as shown+focused' }],
				options: [{ flags: '--json', description: 'Output JSON for automation' }],
				configure: (command) => {
					command.addHelpText(
						'after',
						'\nExamples:\n  $ argus watcher show app\n  $ argus watcher show app --json\n\nSame behavior as `argus page show <id>`. Unthrottles rAF/timers when the\nChrome window is backgrounded or covered; sticky until `watcher hide`.\n',
					)
				},
				action: async (id, options) => {
					await runPageShow(id, options)
				},
			},
			{
				name: 'hide',
				description: "Release the watcher's visibility lock (alias for `argus page hide`)",
				arguments: [{ flags: '[id]', description: 'Watcher id whose page to release from the visibility lock' }],
				options: [{ flags: '--json', description: 'Output JSON for automation' }],
				examples: ['argus watcher hide app', 'argus watcher hide app --json'],
				action: async (id, options) => {
					await runPageHide(id, options)
				},
			},
			{
				name: 'prune',
				alias: 'clean',
				description: 'Remove unreachable watchers from the registry',
				options: [
					{ flags: '--by-cwd <substring>', description: 'Filter watchers by working directory substring' },
					{ flags: '--dry-run', description: 'Preview what would be removed without changing the registry' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus watcher prune',
					'argus watcher prune --by-cwd my-project',
					'argus watcher prune --dry-run',
					'argus watcher prune --dry-run --json',
				],
				action: async (options) => {
					await runWatcherPrune(options)
				},
			},
			{
				name: 'native-host',
				description: '[internal] Start as Native Messaging host for Chrome extension',
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id (default: extension)' },
					{ flags: '--role <role>', description: 'Native host role: tab or control (default: tab)' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				action: async (options) => {
					await runWatcherNativeHost(options)
				},
			},
		],
	},
]
