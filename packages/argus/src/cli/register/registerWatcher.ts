import type { Command } from 'commander'
import { runList } from '../../commands/list.js'
import { runReload } from '../../commands/reload.js'
import { runWatcherStart } from '../../commands/watcherStart.js'
import { runWatcherStatus } from '../../commands/watcherStatus.js'
import { runWatcherStop } from '../../commands/watcherStop.js'
import { runWatcherPrune } from '../../commands/watcherPrune.js'
import { runWatcherNativeHost } from '../../commands/watcherNativeHost.js'
import { loadArgusConfig, mergeWatcherStartOptionsWithConfig, resolveArgusConfigPath } from '../../config/argusConfig.js'

export function registerWatcher(program: Command): void {
	const watcher = program.command('watcher').alias('watchers').description('Watcher management commands')

	watcher
		.command('start')
		.alias('attach')
		.description('Start an Argus watcher process')
		.option('--id <watcherId>', 'Watcher id to announce in the registry (auto-generated if omitted)')
		.option('--source <mode>', 'Source mode: cdp (default) or extension')
		.option('--url <url>', 'URL pattern to match for capturing logs (CDP mode only)')
		.option('--type <type>', 'Filter by target type (e.g., page, iframe, worker) (CDP mode only)')
		.option('--origin <origin>', 'Match against URL origin only (protocol + host + port) (CDP mode only)')
		.option('--target <targetId>', 'Connect to a specific target by its Chrome target ID (CDP mode only)')
		.option('--parent <pattern>', 'Filter by parent target URL pattern (CDP mode only)')
		.option('--chrome-host <host>', 'Chrome CDP host (default: 127.0.0.1) (CDP mode only)')
		.option('--chrome-port <port>', 'Chrome CDP port (default: 9222) (CDP mode only)')
		.option('--artifacts <dir>', 'Artifacts base directory (default: $TMPDIR/argus)')
		.option('--no-page-indicator', 'Disable the in-page watcher indicator (CDP mode only)')
		.option('--inject <path>', 'Path to JavaScript file to inject on watcher attach (CDP mode only)')
		.option('--config <path>', 'Path to Argus config file')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus watcher start --url localhost:3000              # auto-generated id\n  $ argus watcher start --id app --url localhost:3000\n  $ argus watcher start --id app --source extension\n  $ argus watcher start --id game --type iframe --url localhost:3007\n  $ argus watcher start --id game --origin https://localhost:3007\n  $ argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344\n  $ argus watcher start --id game --type iframe --parent yandex.ru\n  $ argus watcher start --id app --url localhost:3000 --no-page-indicator\n  $ argus watcher start --id app --url localhost:3000 --inject ./scripts/debug.js\n  $ argus watcher start --id app --url localhost:3000 --json\n  $ argus watcher attach --id app --url localhost:3000\n',
		)
		.action(async (options, command) => {
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
		})

	watcher
		.command('stop')
		.alias('kill')
		.alias('detach')
		.argument('[id]', 'Watcher id to stop')
		.option('--id <watcherId>', 'Watcher id to stop')
		.description('Stop a watcher')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus watcher stop app\n  $ argus watcher stop --id app\n  $ argus watcher kill app\n  $ argus watcher detach app\n',
		)
		.action(async (id, options) => {
			await runWatcherStop(id ?? options.id, options)
		})

	watcher
		.command('status')
		.alias('ping')
		.argument('[id]', 'Watcher id to query')
		.description('Check watcher status')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus watcher status app\n  $ argus watcher status app --json\n')
		.action(async (id, options) => {
			await runWatcherStatus(id, options)
		})

	watcher
		.command('ls')
		.alias('list')
		.description('List registered watchers')
		.option('--json', 'Output JSON for automation')
		.option('--by-cwd <substring>', 'Filter watchers by working directory substring')
		.addHelpText('after', '\nExamples:\n  $ argus watcher ls\n  $ argus watcher ls --json\n  $ argus watcher ls --by-cwd my-project\n')
		.action(async (options) => {
			await runList(options)
		})

	watcher
		.command('reload')
		.argument('[id]', 'Watcher id to reload')
		.description('Reload the page attached to a watcher')
		.option('--ignore-cache', 'Bypass browser cache')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus watcher reload app\n  $ argus watcher reload app --ignore-cache\n  $ argus watcher reload app --json\n',
		)
		.action(async (id, options) => {
			await runReload(id, options)
		})

	watcher
		.command('prune')
		.alias('clean')
		.description('Remove unreachable watchers from the registry')
		.option('--by-cwd <substring>', 'Filter watchers by working directory substring')
		.option('--dry-run', 'Preview what would be removed without changing the registry')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus watcher prune\n  $ argus watcher prune --by-cwd my-project\n  $ argus watcher prune --dry-run\n  $ argus watcher prune --dry-run --json\n',
		)
		.action(async (options) => {
			await runWatcherPrune(options)
		})

	watcher
		.command('native-host')
		.description('[internal] Start as Native Messaging host for Chrome extension')
		.option('--id <watcherId>', 'Watcher id (default: extension)')
		.option('--json', 'Output JSON for automation')
		.action(async (options) => {
			await runWatcherNativeHost(options)
		})
}
