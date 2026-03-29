import type { Command } from 'commander'
import { runList } from '../../commands/list.js'
import { runStart } from '../../commands/start.js'
import { runDoctor } from '../../commands/doctor.js'
import { runReload } from '../../commands/reload.js'
import {
	loadArgusConfig,
	mergeChromeStartOptionsWithConfig,
	mergeWatcherStartOptionsWithConfig,
	resolveArgusConfigPath,
} from '../../config/argusConfig.js'

export function registerQuickAccess(program: Command): void {
	program
		.command('list')
		.alias('ls')
		.description('List watchers and Chrome instances')
		.option('--json', 'Output JSON for automation')
		.option('--by-cwd <substring>', 'Filter watchers by working directory substring')
		.addHelpText('after', '\nExamples:\n  $ argus list\n  $ argus ls\n  $ argus list --json\n  $ argus list --by-cwd my-project\n')
		.action(async (options) => {
			await runList(options)
		})

	program
		.command('start')
		.description('Launch Chrome and attach a watcher in one command')
		.requiredOption('--id <watcherId>', 'Watcher id')
		.option('--url <url>', 'URL to open in Chrome and match for the watcher')
		.option('--auth-from <watcherId>', 'Clone auth state from another watcher into a fresh temp Chrome session before attaching')
		.option('--profile <type>', 'Chrome profile mode: temp, default-full, default-medium, or default-lite (default: default-lite)')
		.option('--dev-tools', 'Open DevTools for new tabs')
		.option('--headless', 'Run Chrome in headless mode')
		.option('--type <type>', 'Filter by target type (e.g., page, iframe, worker)')
		.option('--origin <origin>', 'Match against URL origin only (protocol + host + port)')
		.option('--target <targetId>', 'Connect to a specific target by its Chrome target ID')
		.option('--parent <pattern>', 'Filter by parent target URL pattern')
		.option('--no-page-indicator', 'Disable the in-page watcher indicator')
		.option('--inject <path>', 'Path to JavaScript file to inject on watcher attach')
		.option('--artifacts <dir>', 'Artifacts base directory')
		.option('--config <path>', 'Path to Argus config file')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus start --id app --url localhost:3000\n  $ argus start --id app --auth-from extension-2\n  $ argus start --id app --auth-from extension-2 --url https://target.app/\n  $ argus start --id app --url localhost:3000 --dev-tools\n  $ argus start --id app --url localhost:3000 --profile temp\n  $ argus start --id app --type page --headless\n  $ argus start --id app --url localhost:3000 --inject ./debug.js\n  $ argus start --id app --url localhost:3000 --json\n',
		)
		.action(async (options, command) => {
			const { config: configPath, inject, ...rest } = options
			const cliOptions = {
				...rest,
				inject: inject ? { file: inject } : undefined,
			}
			if (!normalizeStartAuthOptions(command, cliOptions)) {
				return
			}
			const resolvedPath = resolveArgusConfigPath({ cliPath: configPath, cwd: process.cwd() })
			if (!resolvedPath) {
				if (configPath) {
					return
				}
				await runStart(applyStartAuthOverrides(command, cliOptions))
				return
			}

			const configResult = loadArgusConfig(resolvedPath)
			if (!configResult) {
				return
			}

			const mergedChrome = mergeChromeStartOptionsWithConfig(cliOptions, command, configResult)
			if (!mergedChrome) {
				return
			}

			const mergedWatcher = mergeWatcherStartOptionsWithConfig(mergedChrome, command, configResult)
			if (!mergedWatcher) {
				return
			}

			await runStart(applyStartAuthOverrides(command, mergedWatcher))
		})

	program
		.command('doctor')
		.description('Run environment diagnostics for Argus')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus doctor\n  $ argus doctor --json\n')
		.action(async (options) => {
			await runDoctor(options)
		})

	program
		.command('reload')
		.argument('[id]', 'Watcher id to reload')
		.description('Reload the page attached to a watcher')
		.option('--ignore-cache', 'Bypass browser cache')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus reload app\n  $ argus reload app --ignore-cache\n  $ argus reload app --json\n')
		.action(async (id, options) => {
			await runReload(id, options)
		})
}

const normalizeStartAuthOptions = (command: Command, options: { authFrom?: string; profile?: string }): boolean => {
	if (!options.authFrom) {
		return true
	}

	if (getOptionValueSource(command, 'profile') === 'cli') {
		if (options.profile && options.profile !== 'temp') {
			console.error('Cannot combine --auth-from with a copied Chrome profile. Use --profile temp or omit --profile.')
			process.exitCode = 2
			return false
		}
		return true
	}

	options.profile = undefined
	return true
}

const applyStartAuthOverrides = <T extends { authFrom?: string; profile?: string; url?: string }>(command: Command, options: T): T => {
	if (!options.authFrom) {
		return options
	}

	options.profile = 'temp'
	if (getOptionValueSource(command, 'url') !== 'cli') {
		options.url = undefined
	}
	return options
}

const getOptionValueSource = (command: Command, key: string): string => command.getOptionValueSource(key) ?? ''
