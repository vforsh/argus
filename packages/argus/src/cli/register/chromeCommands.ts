import type { Command } from 'commander'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import type { ChromeStartOptions } from '../../commands/chromeStart.js'
import { runChromeStart } from '../../commands/chromeStart.js'
import { runChromeVersion, runChromeStatus, runChromeList, runChromeStop } from '../../commands/chrome.js'
import { isCliProvided, resolveOptionsWithConfig } from '../../config/configContext.js'
import { mergeChromeStartOptionsWithConfig } from '../../config/mergeConfig.js'
import { jsonOption } from './sharedOptions.js'
import { usageError } from '../validation.js'

const cdpTargetOptions = [
	{ flags: '--cdp <host:port>', description: 'CDP host:port' },
	{ flags: '--id <watcherId>', description: 'Use chrome config from a registered watcher' },
	jsonOption,
] as const

export const chromeCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'chrome',
		alias: 'browser',
		description: 'Chrome/Chromium management commands',
		subcommands: [
			{
				name: 'start',
				description: 'Launch Chrome with CDP enabled',
				options: [
					{ flags: '--url <url>', description: 'URL to open in Chrome' },
					{ flags: '--from-watcher <watcherId>', description: 'Use match.url from a registered watcher' },
					{
						flags: '--profile <type>',
						description: 'Profile mode: temp, default-full, default-medium, or default-lite (default: default-lite)',
					},
					{ flags: '--auth-state <path>', description: 'Load a portable auth snapshot into a fresh temp Chrome profile' },
					{ flags: '--dev-tools', description: 'Open DevTools for new tabs' },
					{ flags: '--headless', description: 'Run Chrome in headless mode (no visible window)' },
					{ flags: '--config <path>', description: 'Path to Argus config file' },
					jsonOption,
				],
				examples: [
					'argus chrome start',
					'argus chrome start --url http://localhost:3000',
					'argus chrome start --from-watcher app',
					'argus chrome start --profile default-full',
					'argus chrome start --profile default-medium',
					'argus chrome start --profile default-lite',
					'argus chrome start --profile temp',
					'argus chrome start --auth-state ./auth.json',
					'argus chrome start --dev-tools',
					'argus chrome start --headless',
					'argus chrome start --json',
				],
				action: async (options, command) => {
					const { config: configPath, ...cliOptions } = options
					if (!normalizeAuthStateProfileOptions(command, cliOptions)) {
						return
					}
					const startOptions = resolveChromeStartOptions(command, cliOptions, configPath)
					if (!startOptions) {
						return
					}

					await runChromeStart(startOptions)
				},
			},
			{
				name: 'ls',
				alias: 'list',
				description: 'List running Chrome instances with CDP enabled',
				options: [
					jsonOption,
					{ flags: '--pages', description: 'List individual pages for each instance' },
				],
				examples: ['argus chrome ls', 'argus chrome ls --pages', 'argus chrome ls --json --pages'],
				action: async (options) => {
					await runChromeList(options)
				},
			},
			{
				name: 'version',
				description: 'Show Chrome version info from CDP endpoint',
				options: cdpTargetOptions,
				examples: [
					'argus chrome version',
					'argus chrome version --cdp 127.0.0.1:9222',
					'argus chrome version --id app',
					'argus chrome version --json',
				],
				action: async (options) => {
					await runChromeVersion(options)
				},
			},
			{
				name: 'status',
				description: 'Check if Chrome CDP endpoint is reachable',
				options: cdpTargetOptions,
				examples: ['argus chrome status', 'argus chrome status --cdp 127.0.0.1:9222', 'argus chrome status --id app'],
				action: async (options) => {
					await runChromeStatus(options)
				},
			},
			{
				name: 'stop',
				alias: 'quit',
				description: 'Close the Chrome instance via CDP',
				options: cdpTargetOptions,
				examples: ['argus chrome stop', 'argus chrome stop --id app', 'argus chrome stop --json'],
				action: async (options) => {
					await runChromeStop(options)
				},
			},
		],
	},
]

const normalizeAuthStateProfileOptions = (command: Command, options: { json?: boolean; authState?: string; profile?: string }): boolean => {
	if (!options.authState) {
		return true
	}

	if (isCliProvided(command, 'profile')) {
		if (options.profile && options.profile !== 'temp') {
			return usageError(options, 'Cannot combine --auth-state with a copied Chrome profile. Use --profile temp or omit --profile.')
		}
		return true
	}

	options.profile = undefined
	return true
}

const resolveChromeStartOptions = (command: Command, cliOptions: ChromeStartOptions, configPath: string | undefined): ChromeStartOptions | null => {
	const merged = resolveOptionsWithConfig(command, cliOptions, configPath, (options, sources, config) =>
		mergeChromeStartOptionsWithConfig(options, sources, config),
	)

	return merged ? applyAuthStateOptionOverrides(command, merged) : null
}

const applyAuthStateOptionOverrides = <T extends { authState?: string; profile?: string; url?: string; fromWatcher?: string }>(
	command: Command,
	options: T,
): T => {
	if (!options.authState) {
		return options
	}

	options.profile = 'temp'
	if (!isCliProvided(command, 'url')) {
		options.url = undefined
	}
	if (!isCliProvided(command, 'fromWatcher')) {
		options.fromWatcher = undefined
	}
	return options
}
