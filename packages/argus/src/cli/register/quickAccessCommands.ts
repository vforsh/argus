import type { Command } from 'commander'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runList } from '../../commands/list.js'
import { runStart } from '../../commands/start.js'
import { runDoctor } from '../../commands/doctor.js'
import { runReload } from '../../commands/reload.js'
import { loadArgusConfig, resolveArgusConfigPath } from '../../config/loadConfig.js'
import { mergeChromeStartOptionsWithConfig, mergeWatcherStartOptionsWithConfig } from '../../config/mergeConfig.js'

export const quickAccessCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'list',
		alias: 'ls',
		description: 'List watchers and Chrome instances',
		options: [
			{ flags: '--json', description: 'Output JSON for automation' },
			{ flags: '--by-cwd <substring>', description: 'Filter watchers by working directory substring' },
		],
		examples: ['argus list', 'argus ls', 'argus list --json', 'argus list --by-cwd my-project'],
		action: async (options) => {
			await runList(options)
		},
	},
	{
		name: 'start',
		description: 'Launch Chrome and attach a watcher in one command',
		options: [
			{ flags: '--id <watcherId>', description: 'Watcher id', required: true },
			{ flags: '--url <url>', description: 'URL to open in Chrome and match for the watcher' },
			{
				flags: '--auth-from <watcherId>',
				description: 'Clone auth state from another watcher into a fresh temp Chrome session before attaching',
			},
			{
				flags: '--profile <type>',
				description: 'Chrome profile mode: temp, default-full, default-medium, or default-lite (default: default-lite)',
			},
			{ flags: '--dev-tools', description: 'Open DevTools for new tabs' },
			{ flags: '--headless', description: 'Run Chrome in headless mode' },
			{ flags: '--type <type>', description: 'Filter by target type (e.g., page, iframe, worker)' },
			{ flags: '--origin <origin>', description: 'Match against URL origin only (protocol + host + port)' },
			{ flags: '--target <targetId>', description: 'Connect to a specific target by its Chrome target ID' },
			{ flags: '--parent <pattern>', description: 'Filter by parent target URL pattern' },
			{ flags: '--no-page-indicator', description: 'Disable the in-page watcher indicator' },
			{ flags: '--inject <path>', description: 'Path to JavaScript file to inject on watcher attach' },
			{ flags: '--artifacts <dir>', description: 'Artifacts base directory' },
			{ flags: '--config <path>', description: 'Path to Argus config file' },
			{ flags: '--json', description: 'Output JSON for automation' },
		],
		examples: [
			'argus start --id app --url localhost:3000',
			'argus start --id app --auth-from extension-2',
			'argus start --id app --auth-from extension-2 --url https://target.app/',
			'argus start --id app --url localhost:3000 --dev-tools',
			'argus start --id app --url localhost:3000 --profile temp',
			'argus start --id app --type page --headless',
			'argus start --id app --url localhost:3000 --inject ./debug.js',
			'argus start --id app --url localhost:3000 --json',
		],
		action: async (options, command) => {
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
		},
	},
	{
		name: 'doctor',
		description: 'Run environment diagnostics for Argus',
		options: [{ flags: '--json', description: 'Output JSON for automation' }],
		examples: ['argus doctor', 'argus doctor --json'],
		action: async (options) => {
			await runDoctor(options)
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
		examples: ['argus reload app', 'argus reload app --ignore-cache', 'argus reload app --json'],
		action: async (id, options) => {
			await runReload(id, options)
		},
	},
]

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
