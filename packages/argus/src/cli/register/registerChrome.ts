import type { Command } from 'commander'
import type { ChromeStartOptions } from '../../commands/chromeStart.js'
import { runChromeStart } from '../../commands/chromeStart.js'
import { runChromeVersion, runChromeStatus, runChromeList, runChromeStop } from '../../commands/chrome.js'
import { loadArgusConfig, mergeChromeStartOptionsWithConfig, resolveArgusConfigPath } from '../../config/argusConfig.js'

export function registerChrome(program: Command): void {
	const chrome = program.command('chrome').alias('browser').description('Chrome/Chromium management commands')

	chrome
		.command('start')
		.description('Launch Chrome with CDP enabled')
		.option('--url <url>', 'URL to open in Chrome')
		.option('--from-watcher <watcherId>', 'Use match.url from a registered watcher')
		.option('--profile <type>', 'Profile mode: temp, default-full, default-medium, or default-lite (default: default-lite)')
		.option('--auth-state <path>', 'Load a portable auth snapshot into a fresh temp Chrome profile')
		.option('--dev-tools', 'Open DevTools for new tabs')
		.option('--headless', 'Run Chrome in headless mode (no visible window)')
		.option('--config <path>', 'Path to Argus config file')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus chrome start\n  $ argus chrome start --url http://localhost:3000\n  $ argus chrome start --from-watcher app\n  $ argus chrome start --profile default-full\n  $ argus chrome start --profile default-medium\n  $ argus chrome start --profile default-lite\n  $ argus chrome start --profile temp\n  $ argus chrome start --auth-state ./auth.json\n  $ argus chrome start --dev-tools\n  $ argus chrome start --headless\n  $ argus chrome start --json\n',
		)
		.action(async (options, command) => {
			const { config: configPath, ...cliOptions } = options
			if (!normalizeAuthStateProfileOptions(command, cliOptions)) {
				return
			}
			const startOptions = resolveChromeStartOptions(command, cliOptions, configPath)
			if (!startOptions) {
				return
			}

			await runChromeStart(startOptions)
		})

	chrome
		.command('ls')
		.alias('list')
		.description('List running Chrome instances with CDP enabled')
		.option('--json', 'Output JSON for automation')
		.option('--pages', 'List individual pages for each instance')
		.addHelpText('after', '\nExamples:\n  $ argus chrome ls\n  $ argus chrome ls --pages\n  $ argus chrome ls --json --pages\n')
		.action(async (options) => {
			await runChromeList(options)
		})

	chrome
		.command('version')
		.description('Show Chrome version info from CDP endpoint')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus chrome version\n  $ argus chrome version --cdp 127.0.0.1:9222\n  $ argus chrome version --id app\n  $ argus chrome version --json\n',
		)
		.action(async (options) => {
			await runChromeVersion(options)
		})

	chrome
		.command('status')
		.description('Check if Chrome CDP endpoint is reachable')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus chrome status\n  $ argus chrome status --cdp 127.0.0.1:9222\n  $ argus chrome status --id app\n',
		)
		.action(async (options) => {
			await runChromeStatus(options)
		})

	chrome
		.command('stop')
		.alias('quit')
		.description('Close the Chrome instance via CDP')
		.option('--cdp <host:port>', 'CDP host:port')
		.option('--id <watcherId>', 'Use chrome config from a registered watcher')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus chrome stop\n  $ argus chrome stop --id app\n  $ argus chrome stop --json\n')
		.action(async (options) => {
			await runChromeStop(options)
		})
}

const normalizeAuthStateProfileOptions = (command: Command, options: { authState?: string; profile?: string }): boolean => {
	if (!options.authState) {
		return true
	}

	if (getOptionValueSource(command, 'profile') === 'cli') {
		if (options.profile && options.profile !== 'temp') {
			console.error('Cannot combine --auth-state with a copied Chrome profile. Use --profile temp or omit --profile.')
			process.exitCode = 2
			return false
		}
		return true
	}

	options.profile = undefined
	return true
}

const resolveChromeStartOptions = (command: Command, cliOptions: ChromeStartOptions, configPath: string | undefined): ChromeStartOptions | null => {
	const resolvedPath = resolveArgusConfigPath({ cliPath: configPath, cwd: process.cwd() })
	if (!resolvedPath) {
		return configPath ? null : applyAuthStateOptionOverrides(command, cliOptions)
	}

	const configResult = loadArgusConfig(resolvedPath)
	if (!configResult) {
		return null
	}

	const merged = mergeChromeStartOptionsWithConfig(cliOptions, createOptionSourceProvider(command), configResult)
	if (!merged) {
		return null
	}

	return applyAuthStateOptionOverrides(command, merged)
}

const applyAuthStateOptionOverrides = <T extends { authState?: string; profile?: string; url?: string; fromWatcher?: string }>(
	command: Command,
	options: T,
): T => {
	if (!options.authState) {
		return options
	}

	options.profile = 'temp'
	if (getOptionValueSource(command, 'url') !== 'cli') {
		options.url = undefined
	}
	if (getOptionValueSource(command, 'fromWatcher') !== 'cli') {
		options.fromWatcher = undefined
	}
	return options
}

const createOptionSourceProvider = (command: Command): { getOptionValueSource: (key: string) => string } => ({
	getOptionValueSource: (key) => getOptionValueSource(command, key),
})

const getOptionValueSource = (command: Command, key: string): string => command.getOptionValueSource(key) ?? ''
