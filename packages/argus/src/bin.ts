#!/usr/bin/env bun
import { Command } from 'commander'
import { runList } from './commands/list.js'
import { runLogs } from './commands/logs.js'
import { runTail } from './commands/tail.js'
import { runNet } from './commands/net.js'
import { runNetTail } from './commands/netTail.js'
import { runEval } from './commands/eval.js'
import { runEvalUntil } from './commands/evalUntil.js'
import { runIframeHelper } from './commands/iframeHelper.js'
import { runTrace, runTraceStart, runTraceStop } from './commands/trace.js'
import { runScreenshot } from './commands/screenshot.js'
import { runSnapshot } from './commands/snapshot.js'
import { runReload } from './commands/reload.js'
import { runDomTree } from './commands/domTree.js'
import { runDomInfo } from './commands/domInfo.js'
import { runDomHover } from './commands/domHover.js'
import { runDomClick } from './commands/domClick.js'
import { runDomKeydown } from './commands/domKeydown.js'
import { runDomAdd } from './commands/domAdd.js'
import { runDomAddScript } from './commands/domAddScript.js'
import { runDomRemove } from './commands/domRemove.js'
import { runDomSetFile } from './commands/domSetFile.js'
import { runDomFill } from './commands/domFill.js'
import { runDomModifyAttr, runDomModifyClass, runDomModifyStyle, runDomModifyText, runDomModifyHtml } from './commands/domModify.js'
import { runChromeStart } from './commands/chromeStart.js'
import { runStart } from './commands/start.js'
import {
	runChromeVersion,
	runChromeStatus,
	runChromeTargets,
	runChromeOpen,
	runChromeActivate,
	runChromeClose,
	runChromeStop,
	runChromeList,
} from './commands/chrome.js'
import { runPageReload } from './commands/page.js'
import { runDoctor } from './commands/doctor.js'
import { runWatcherStart } from './commands/watcherStart.js'
import { runWatcherStatus } from './commands/watcherStatus.js'
import { runWatcherStop } from './commands/watcherStop.js'
import { runWatcherPrune } from './commands/watcherPrune.js'
import { runWatcherNativeHost } from './commands/watcherNativeHost.js'
import { runStorageLocalGet, runStorageLocalSet, runStorageLocalRemove, runStorageLocalList, runStorageLocalClear } from './commands/storageLocal.js'
import { runConfigInit } from './commands/configInit.js'
import { runExtensionSetup } from './commands/extension/setup.js'
import { runExtensionRemove } from './commands/extension/remove.js'
import { runExtensionStatus } from './commands/extension/status.js'
import { runExtensionInfo } from './commands/extension/info.js'
import {
	loadArgusConfig,
	mergeChromeStartOptionsWithConfig,
	mergeWatcherStartOptionsWithConfig,
	resolveArgusConfigPath,
} from './config/argusConfig.js'
import { PluginRegistry } from './plugins/registry.js'

const collectMatch = (value: string, previous: string[]): string[] => [...previous, value]
const collectParam = (value: string, previous: string[]): string[] => [...previous, value]

const validateCaseFlags = (options: { ignoreCase?: boolean; caseSensitive?: boolean }): boolean => {
	if (options.ignoreCase && options.caseSensitive) {
		console.error('Cannot combine --ignore-case with --case-sensitive.')
		process.exitCode = 2
		return false
	}
	return true
}

const validateMatchOptions = (options: { match?: string[] }): boolean => {
	if (!options.match || options.match.length === 0) {
		return true
	}

	const invalid = options.match.find((value) => value.trim().length === 0)
	if (invalid != null) {
		console.error('Invalid --match value: empty pattern.')
		process.exitCode = 2
		return false
	}
	options.match = options.match.map((value) => value.trim())
	return true
}

const program = new Command()

program
	.name('argus')
	.description('Argus CLI for local watcher servers')
	.version('0.1.0')
	.configureOutput({
		outputError: (str, write) => write(str),
	})
	.showSuggestionAfterError(true)
	.exitOverride((error) => {
		if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
			process.exit(0)
		}
		console.error(error.message)
		process.exit(2)
	})

// ---------------------------------------------------------------------------
// Quick access
// ---------------------------------------------------------------------------

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
		'\nExamples:\n  $ argus start --id app --url localhost:3000\n  $ argus start --id app --url localhost:3000 --dev-tools\n  $ argus start --id app --url localhost:3000 --profile temp\n  $ argus start --id app --type page --headless\n  $ argus start --id app --url localhost:3000 --inject ./debug.js\n  $ argus start --id app --url localhost:3000 --json\n',
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
			await runStart(cliOptions)
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

		await runStart(mergedWatcher)
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

// ---------------------------------------------------------------------------
// Setup & infrastructure
// ---------------------------------------------------------------------------

const chrome = program.command('chrome').alias('browser').description('Chrome/Chromium management commands')

chrome
	.command('start')
	.description('Launch Chrome with CDP enabled')
	.option('--url <url>', 'URL to open in Chrome')
	.option('--from-watcher <watcherId>', 'Use match.url from a registered watcher')
	.option('--profile <type>', 'Profile mode: temp, default-full, default-medium, or default-lite (default: default-lite)')
	.option('--dev-tools', 'Open DevTools for new tabs')
	.option('--headless', 'Run Chrome in headless mode (no visible window)')
	.option('--config <path>', 'Path to Argus config file')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus chrome start\n  $ argus chrome start --url http://localhost:3000\n  $ argus chrome start --from-watcher app\n  $ argus chrome start --profile default-full\n  $ argus chrome start --profile default-medium\n  $ argus chrome start --profile default-lite\n  $ argus chrome start --profile temp\n  $ argus chrome start --dev-tools\n  $ argus chrome start --headless\n  $ argus chrome start --json\n',
	)
	.action(async (options, command) => {
		const { config: configPath, ...cliOptions } = options
		const resolvedPath = resolveArgusConfigPath({ cliPath: configPath, cwd: process.cwd() })
		if (!resolvedPath) {
			if (configPath) {
				return
			}
			await runChromeStart(cliOptions)
			return
		}

		const configResult = loadArgusConfig(resolvedPath)
		if (!configResult) {
			return
		}

		const merged = mergeChromeStartOptionsWithConfig(cliOptions, command, configResult)
		if (!merged) {
			return
		}

		await runChromeStart(merged)
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
	.addHelpText('after', '\nExamples:\n  $ argus chrome status\n  $ argus chrome status --cdp 127.0.0.1:9222\n  $ argus chrome status --id app\n')
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

const watcher = program.command('watcher').alias('watchers').description('Watcher management commands')

watcher
	.command('start')
	.alias('attach')
	.description('Start an Argus watcher process')
	.option('--id <watcherId>', 'Watcher id to announce in the registry')
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
		'\nExamples:\n  $ argus watcher start --id app --url localhost:3000\n  $ argus watcher start --id app --source extension\n  $ argus watcher start --id game --type iframe --url localhost:3007\n  $ argus watcher start --id game --origin https://localhost:3007\n  $ argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344\n  $ argus watcher start --id game --type iframe --parent yandex.ru\n  $ argus watcher start --id app --url localhost:3000 --no-page-indicator\n  $ argus watcher start --id app --url localhost:3000 --inject ./scripts/debug.js\n  $ argus watcher start --id app --url localhost:3000 --json\n  $ argus watcher attach --id app --url localhost:3000\n',
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

const page = program.command('page').alias('tab').description('Page/tab management commands')

page.command('ls')
	.aliases(['targets', 'list'])
	.description('List Chrome targets (tabs, extensions, etc.)')
	.option('--type <type>', 'Filter by target type (e.g. page, worker, iframe)')
	.option('--tree', 'Show targets as a tree with parent-child relationships')
	.option('--cdp <host:port>', 'CDP host:port')
	.option('--id <watcherId>', 'Use chrome config from a registered watcher')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus page ls\n  $ argus page ls --type page\n  $ argus page ls --type iframe\n  $ argus page ls --tree\n  $ argus page ls --json\n  $ argus page ls --id app\n',
	)
	.action(async (options) => {
		await runChromeTargets(options)
	})

page.command('open')
	.alias('new')
	.description('Open a new tab in Chrome')
	.requiredOption('--url <url>', 'URL to open')
	.option('--cdp <host:port>', 'CDP host:port')
	.option('--id <watcherId>', 'Use chrome config from a registered watcher')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus page open --url http://localhost:3000\n  $ argus page open --url localhost:3000\n  $ argus page open --url http://example.com --json\n',
	)
	.action(async (options) => {
		await runChromeOpen(options)
	})

page.command('activate')
	.description('Activate (focus) a Chrome target')
	.argument('[targetId]', 'Target ID to activate')
	.option('--title <substring>', 'Case-insensitive substring match against target title')
	.option('--url <substring>', 'Case-insensitive substring match against target URL')
	.option('--match <substring>', 'Case-insensitive substring match against title + URL')
	.option('--cdp <host:port>', 'CDP host:port')
	.option('--id <watcherId>', 'Use chrome config from a registered watcher')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus page activate ABCD1234\n  $ argus page activate --title "Docs"\n  $ argus page activate --url localhost:3000\n  $ argus page activate --match "Argus" --json\n',
	)
	.action(async (targetId, options) => {
		await runChromeActivate({ ...options, targetId })
	})

page.command('close')
	.description('Close a Chrome target')
	.argument('<targetId>', 'Target ID to close')
	.option('--cdp <host:port>', 'CDP host:port')
	.option('--id <watcherId>', 'Use chrome config from a registered watcher')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus page close ABCD1234\n  $ argus page close ABCD1234 --json\n')
	.action(async (targetId, options) => {
		await runChromeClose({ ...options, targetId })
	})

page.command('reload')
	.description('Reload a Chrome target')
	.argument('[targetId]', 'Target ID to reload')
	.option('--attached', 'Reload the attached page for a watcher (requires --id)')
	.option('--cdp <host:port>', 'CDP host:port')
	.option('--id <watcherId>', 'Use chrome config from a registered watcher')
	.option('--param <key=value>', 'Update query param (repeatable, overwrite semantics)', collectParam, [])
	.option('--params <a=b&c=d>', 'Update query params from string (overwrite semantics)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus page reload ABCD1234\n  $ argus page reload --attached --id app\n  $ argus page reload ABCD1234 --json\n  $ argus page reload ABCD1234 --param foo=bar\n  $ argus page reload ABCD1234 --param foo=bar --param baz=qux\n  $ argus page reload ABCD1234 --params "a=1&b=2"\n',
	)
	.action(async (targetId, options) => {
		await runPageReload({ ...options, targetId })
	})

// ---------------------------------------------------------------------------
// Inspect & debug
// ---------------------------------------------------------------------------

const logs = program
	.command('logs')
	.alias('log')
	.argument('[id]', 'Watcher id to query')
	.description('Fetch recent logs from a watcher')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--match <regex>', 'Filter by regex (repeatable)', collectMatch, [])
	.option('--ignore-case', 'Use case-insensitive regex matching')
	.option('--case-sensitive', 'Use case-sensitive regex matching')
	.option('--source <pattern>', 'Filter by source substring')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--after <id>', 'Only return events after this id')
	.option('--limit <count>', 'Maximum number of events')
	.option('--json', 'Output bounded JSON preview for automation')
	.option('--json-full', 'Output full JSON (can be very large)')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus logs app\n  $ argus logs app --since 10m --levels error,warning\n  $ argus logs app --json\n  $ argus logs app --json-full\n',
	)
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		if (!validateCaseFlags(options)) {
			return
		}
		if (!validateMatchOptions(options)) {
			return
		}
		await runLogs(id, options)
	})

logs.command('tail')
	.argument('[id]', 'Watcher id to follow')
	.description('Stream logs via long-polling')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--match <regex>', 'Filter by regex (repeatable)', collectMatch, [])
	.option('--ignore-case', 'Use case-insensitive regex matching')
	.option('--case-sensitive', 'Use case-sensitive regex matching')
	.option('--source <pattern>', 'Filter by source substring')
	.option('--after <id>', 'Start after this event id')
	.option('--limit <count>', 'Maximum number of events per poll')
	.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	.option('--json', 'Output bounded newline-delimited JSON events')
	.option('--json-full', 'Output full newline-delimited JSON events (can be very large)')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus logs tail app\n  $ argus logs tail app --levels error\n  $ argus logs tail app --json\n  $ argus logs tail app --json-full\n',
	)
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		if (!validateCaseFlags(options)) {
			return
		}
		if (!validateMatchOptions(options)) {
			return
		}
		await runTail(id, options)
	})

const net = program
	.command('net')
	.alias('network')
	.argument('[id]', 'Watcher id to query')
	.description('Fetch recent network request summaries from a watcher')
	.option('--after <id>', 'Only return requests after this id')
	.option('--limit <count>', 'Maximum number of requests')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--grep <substring>', 'Substring match over redacted URLs')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus net app --since 5m\n  $ argus net app --grep api\n  $ argus net app --json\n')
	.action(async (id, options) => {
		await runNet(id, options)
	})

net.command('tail')
	.argument('[id]', 'Watcher id to follow')
	.description('Tail network request summaries via long-polling')
	.option('--after <id>', 'Start after this request id')
	.option('--limit <count>', 'Maximum number of requests per poll')
	.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--grep <substring>', 'Substring match over redacted URLs')
	.option('--json', 'Output newline-delimited JSON requests')
	.addHelpText('after', '\nExamples:\n  $ argus net tail app\n  $ argus net tail app --grep api\n  $ argus net tail app --json\n')
	.action(async (id, options) => {
		await runNetTail(id, options)
	})

const evalCmd = program
	.command('eval')
	.alias('e')
	.argument('[id]', 'Watcher id to query')
	.argument('[expression]', 'JS expression to evaluate (or use --file / --stdin)')
	.description('Evaluate a JS expression in the connected page')
	.option('--no-await', 'Do not await promises')
	.option('--timeout <ms>', 'Eval timeout in milliseconds')
	.option('--json', 'Output JSON for automation')
	.option('--no-return-by-value', 'Disable returnByValue (use preview)')
	.option('--no-fail-on-exception', 'Do not exit with code 1 when the evaluation throws')
	.option('--retry <n>', 'Retry failed evaluations up to N times')
	.option('-q, --silent', 'Suppress success output; only emit output on error')
	.option('--interval <ms|duration>', 'Re-evaluate every interval (e.g. 500, 3s)')
	.option('--count <n>', 'Stop after N iterations (requires --interval)')
	.option('--until <condition>', 'Stop when local condition becomes truthy (requires --interval)')
	.option('-f, --file <path>', 'Read expression from a file')
	.option('--stdin', 'Read expression from stdin')
	.option('--iframe <selector>', 'Eval in iframe via postMessage (requires helper script)')
	.option('--iframe-namespace <name>', 'Message type prefix for iframe eval (default: argus)')
	.option('--iframe-timeout <ms>', 'Timeout for iframe postMessage response (default: 5000)')
	.addHelpText(
		'after',
		`
Examples:
  $ argus eval app "location.href"
  $ argus eval app "await fetch('/ping').then(r => r.status)"
  $ argus eval app --file ./script.js
  $ cat script.js | argus eval app --stdin
  $ argus eval app - < script.js
  $ argus eval app "document.title" --no-fail-on-exception
  $ argus eval app "1+1" --retry 3
  $ argus eval app "1+1" --silent
  $ argus eval app "Date.now()" --interval 500 --count 10
  $ argus eval app "document.title" --interval 250 --until 'result === "ready"'
  $ argus eval app "window.gameState" --iframe "iframe#game"
  $ argus eval app "document.title" --iframe "iframe" --iframe-timeout 10000
`,
	)
	.action(async (id, expression, options) => {
		await runEval(id, expression, {
			json: options.json,
			await: options.await,
			timeout: options.timeout,
			returnByValue: options.returnByValue,
			failOnException: options.failOnException,
			retry: options.retry,
			silent: options.silent,
			interval: options.interval,
			count: options.count,
			until: options.until,
			file: options.file,
			stdin: options.stdin,
			iframe: options.iframe,
			iframeNamespace: options.iframeNamespace,
			iframeTimeout: options.iframeTimeout,
		})
	})

evalCmd
	.command('iframe-helper')
	.description('Output helper script for cross-origin iframe eval via postMessage')
	.option('--out <file>', 'Write script to file instead of stdout')
	.option('--no-log', 'Omit console.log confirmation')
	.option('--iife', 'Wrap in IIFE to avoid global scope')
	.option('--namespace <name>', 'Message type prefix (default: argus)')
	.addHelpText(
		'after',
		`
Examples:
  $ argus eval iframe-helper > helper.js
  $ argus eval iframe-helper --out src/argus.js
  $ argus eval iframe-helper --iife --no-log
  $ argus eval iframe-helper --namespace myapp
`,
	)
	.action(async (options) => {
		await runIframeHelper(options)
	})

program
	.command('eval-until')
	.alias('wait')
	.argument('[id]', 'Watcher id to query')
	.argument('[expression]', 'JS expression to poll until truthy (or use --file / --stdin)')
	.description('Poll a JS expression until it returns a truthy value')
	.option('--no-await', 'Do not await promises')
	.option('--timeout <ms>', 'Per-eval timeout in milliseconds')
	.option('--json', 'Output JSON for automation')
	.option('--no-return-by-value', 'Disable returnByValue (use preview)')
	.option('--no-fail-on-exception', 'Do not exit with code 1 when the evaluation throws')
	.option('--retry <n>', 'Retry failed evaluations up to N times')
	.option('-q, --silent', 'Suppress success output; only emit output on error')
	.option('--interval <ms|duration>', 'Polling interval (default: 250ms)')
	.option('--count <n>', 'Stop after N iterations')
	.option('--total-timeout <duration>', 'Max wall-clock time (e.g. 30s, 2m)')
	.option('--verbose', 'Print intermediate (falsy) results')
	.option('-f, --file <path>', 'Read expression from a file')
	.option('--stdin', 'Read expression from stdin')
	.option('--iframe <selector>', 'Eval in iframe via postMessage (requires helper script)')
	.option('--iframe-namespace <name>', 'Message type prefix for iframe eval (default: argus)')
	.option('--iframe-timeout <ms>', 'Timeout for iframe postMessage response (default: 5000)')
	.addHelpText(
		'after',
		`
Examples:
  $ argus eval-until app "document.querySelector('#loaded')"
  $ argus eval-until app "window.APP_READY" --interval 500
  $ argus eval-until app "document.title === 'Ready'" --total-timeout 30s
  $ argus eval-until app "window.data" --verbose
  $ argus eval-until app "window.data" --count 20 --interval 1s
  $ argus eval-until app --file ./check.js --total-timeout 1m
`,
	)
	.action(async (id, expression, options) => {
		await runEvalUntil(id, expression, {
			json: options.json,
			await: options.await,
			timeout: options.timeout,
			returnByValue: options.returnByValue,
			failOnException: options.failOnException,
			retry: options.retry,
			silent: options.silent,
			interval: options.interval,
			count: options.count,
			totalTimeout: options.totalTimeout,
			verbose: options.verbose,
			file: options.file,
			stdin: options.stdin,
			iframe: options.iframe,
			iframeNamespace: options.iframeNamespace,
			iframeTimeout: options.iframeTimeout,
		})
	})

const dom = program.command('dom').alias('html').description('Inspect DOM elements in the connected page')

dom.command('tree')
	.argument('[id]', 'Watcher id to query')
	.description('Fetch a DOM subtree rooted at element(s) matching a CSS selector')
	.requiredOption('--selector <css>', 'CSS selector to match element(s)')
	.option('--depth <n>', 'Max depth to traverse (default: 2)')
	.option('--max-nodes <n>', 'Max total nodes to return (default: 5000)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom tree app --selector "body"\n  $ argus dom tree app --selector "div" --all --depth 3\n  $ argus dom tree app --selector "#root" --json\n',
	)
	.action(async (id, options) => {
		await runDomTree(id, options)
	})

dom.command('info')
	.argument('[id]', 'Watcher id to query')
	.description('Fetch detailed info for element(s) matching a CSS selector')
	.requiredOption('--selector <css>', 'CSS selector to match element(s)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--outer-html-max <n>', 'Max characters for outerHTML (default: 50000)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom info app --selector "body"\n  $ argus dom info app --selector "div" --all\n  $ argus dom info app --selector "#root" --json\n',
	)
	.action(async (id, options) => {
		await runDomInfo(id, options)
	})

dom.command('hover')
	.argument('[id]', 'Watcher id to query')
	.description('Hover over element(s) matching a CSS selector')
	.requiredOption('--selector <css>', 'CSS selector to match element(s)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom hover app --selector "#btn"\n  $ argus dom hover app --selector ".item" --all\n  $ argus dom hover app --selector "#btn" --json\n',
	)
	.action(async (id, options) => {
		await runDomHover(id, options)
	})

dom.command('click')
	.argument('[id]', 'Watcher id to query')
	.description('Click at coordinates or on element(s) matching a CSS selector')
	.option('--selector <css>', 'CSS selector to match element(s)')
	.option('--pos <x,y>', 'Viewport coordinates or offset from element top-left')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom click app --pos 100,200\n  $ argus dom click app --selector "#btn"\n  $ argus dom click app --selector "#btn" --pos 10,5\n  $ argus dom click app --selector ".item" --all\n  $ argus dom click app --selector "#btn" --json\n',
	)
	.action(async (id, options) => {
		await runDomClick(id, options)
	})

dom.command('keydown')
	.argument('[id]', 'Watcher id to query')
	.description('Dispatch a keyboard event to the connected page')
	.requiredOption('--key <name>', 'Key name (e.g. Enter, a, ArrowUp)')
	.option('--selector <css>', 'Focus element before dispatching')
	.option('--modifiers <list>', 'Comma-separated modifiers: shift,ctrl,alt,meta')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom keydown app --key Enter\n  $ argus dom keydown app --key a --selector "#input"\n  $ argus dom keydown app --key a --modifiers shift,ctrl\n',
	)
	.action(async (id, options) => {
		await runDomKeydown(id, options)
	})

dom.command('add')
	.argument('[id]', 'Watcher id to query')
	.description('Insert HTML into the page relative to matched element(s)')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--html <string>', 'HTML to insert (use "-" for stdin)')
	.option('--html-file <path>', 'Read HTML to insert from a file')
	.option('--html-stdin', 'Read HTML to insert from stdin (same as --html -)')
	.option(
		'--position <pos>',
		'Insert position: beforebegin, afterbegin, beforeend, afterend (aliases: before, after, prepend, append)',
		'beforeend',
	)
	.option('--nth <index>', 'Insert at the zero-based match index')
	.option('--first', 'Insert at the first match (same as --nth 0)')
	.option('--expect <n>', 'Expect N matches before inserting')
	.option('--text', 'Insert text content (uses insertAdjacentText)')
	.option('--all', 'Insert at all matches (default: error if >1 match)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom add app --selector "#container" --html "<div>Hello</div>"\n  $ argus dom add app --selector "body" --position append --html "<script src=\'debug.js\'></script>"\n  $ argus dom add app --selector ".item" --all --position afterend --html "<hr>"\n  $ argus dom add app --selector "#root" --html-file ./snippet.html\n  $ cat snippet.html | argus dom add app --selector "#root" --html -\n  $ argus dom add app --selector ".item" --nth 2 --html "<hr>"\n  $ argus dom add app --selector "#banner" --text --html "Preview mode"\n',
	)
	.action(async (id, options) => {
		await runDomAdd(id, options)
	})

dom.command('add-script')
	.argument('[id]', 'Watcher id to query')
	.argument('[code]', 'Inline JS code to inject (or use --file / --stdin / --src)')
	.description('Add a <script> element to the page')
	.option('--src <url>', 'External script URL (mutually exclusive with code/file/stdin)')
	.option('-f, --file <path>', 'Read JS from file')
	.option('--stdin', 'Read from stdin (also triggered by - as code arg)')
	.option('--type <type>', 'Script type attribute (e.g. "module")')
	.option('--id <id>', 'Script element id attribute')
	.option('--target <el>', 'Append to "head" (default) or "body"')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		`
Examples:
  $ argus dom add-script app "console.log('hello')"
  $ argus dom add-script app --src "https://cdn.example.com/lib.js"
  $ argus dom add-script app --file ./debug.js
  $ cat debug.js | argus dom add-script app --stdin
  $ argus dom add-script app - < debug.js
  $ argus dom add-script app --src "./lib.js" --type module
  $ argus dom add-script app "console.log('tagged')" --id my-debug
  $ argus dom add-script app --file ./init.js --target body
`,
	)
	.action(async (id, code, options) => {
		await runDomAddScript(id, code, {
			src: options.src,
			file: options.file,
			stdin: options.stdin,
			type: options.type,
			scriptId: options.id,
			target: options.target,
			json: options.json,
		})
	})

dom.command('remove')
	.argument('[id]', 'Watcher id to query')
	.description('Remove elements from the page')
	.requiredOption('--selector <css>', 'CSS selector for elements to remove')
	.option('--all', 'Remove all matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom remove app --selector ".debug-overlay"\n  $ argus dom remove app --selector "[data-testid=\'temp\']" --all\n',
	)
	.action(async (id, options) => {
		await runDomRemove(id, options)
	})

const domModify = dom.command('modify').description('Modify DOM element properties')

domModify
	.command('attr')
	.argument('[id]', 'Watcher id to query')
	.argument('[attrs...]', 'Attributes: name (boolean) or name=value')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--remove <attrs...>', 'Attributes to remove')
	.option('--all', 'Apply to all matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom modify attr app --selector "#btn" disabled\n  $ argus dom modify attr app --selector "#btn" data-loading=true aria-label="Submit"\n  $ argus dom modify attr app --selector "#btn" --remove disabled data-temp\n',
	)
	.action(async (id, attrs, options) => {
		await runDomModifyAttr(id, attrs, options)
	})

domModify
	.command('class')
	.argument('[id]', 'Watcher id to query')
	.argument('[classes...]', 'Shorthand: +add, -remove, ~toggle (or plain name to add)')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--add <classes...>', 'Classes to add')
	.option('--remove <classes...>', 'Classes to remove')
	.option('--toggle <classes...>', 'Classes to toggle')
	.option('--all', 'Apply to all matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom modify class app --selector "#btn" --add active highlighted\n  $ argus dom modify class app --selector "#btn" --remove hidden disabled\n  $ argus dom modify class app --selector "#btn" --toggle loading\n  $ argus dom modify class app --selector "#btn" +active +primary -hidden ~loading\n',
	)
	.action(async (id, classes, options) => {
		await runDomModifyClass(id, classes, options)
	})

domModify
	.command('style')
	.argument('[id]', 'Watcher id to query')
	.argument('[styles...]', 'Styles: property=value')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--remove <props...>', 'Style properties to remove')
	.option('--all', 'Apply to all matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom modify style app --selector "#btn" color=red font-size=14px\n  $ argus dom modify style app --selector "#btn" --remove color font-size\n',
	)
	.action(async (id, styles, options) => {
		await runDomModifyStyle(id, styles, options)
	})

domModify
	.command('text')
	.argument('[id]', 'Watcher id to query')
	.argument('<text>', 'Text content to set')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--all', 'Apply to all matches (default: error if >1 match)')
	.option('--text-filter <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom modify text app --selector "#msg" "Hello World"\n  $ argus dom modify text app --selector ".counter" --all "0"\n',
	)
	.action(async (id, text, options) => {
		await runDomModifyText(id, text, { ...options, text: options.textFilter })
	})

domModify
	.command('html')
	.argument('[id]', 'Watcher id to query')
	.argument('<html>', 'HTML content to set')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--all', 'Apply to all matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus dom modify html app --selector "#container" "<p>New <strong>content</strong></p>"\n')
	.action(async (id, html, options) => {
		await runDomModifyHtml(id, html, options)
	})

dom.command('set-file')
	.argument('[id]', 'Watcher id to query')
	.description('Set file(s) on a <input type="file"> element via CDP')
	.requiredOption('--selector <css>', 'CSS selector for file input element(s)')
	.requiredOption('--file <path...>', 'File path(s) to set on the input (repeatable)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom set-file app --selector "input[type=file]" --file ./build.zip\n  $ argus dom set-file app --selector "#upload" --file a.png --file b.png\n',
	)
	.action(async (id, options) => {
		await runDomSetFile(id, options)
	})

dom.command('fill')
	.argument('[id]', 'Watcher id to query')
	.argument('<value>', 'Value to fill into the element')
	.description('Fill input/textarea/contenteditable elements with a value (triggers framework events)')
	.requiredOption('--selector <css>', 'CSS selector for target element(s)')
	.option('--all', 'Allow multiple matches (default: error if >1 match)')
	.option('--text <string>', 'Filter by exact textContent (trimmed)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus dom fill app --selector "#username" "Bob"\n  $ argus dom fill app --selector "textarea" "New content"\n  $ argus dom fill app --selector "input[type=text]" --all "reset"\n',
	)
	.action(async (id, value, options) => {
		await runDomFill(id, value, options)
	})

const storage = program.command('storage').description('Interact with browser storage APIs')

const storageLocal = storage.command('local').description('Manage localStorage for the attached page')

storageLocal
	.command('get')
	.argument('[id]', 'Watcher id')
	.argument('<key>', 'localStorage key to retrieve')
	.option('--origin <origin>', 'Validate page origin matches this value')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus storage local get app myKey\n  $ argus storage local get app myKey --json\n')
	.action(async (id, key, options) => {
		await runStorageLocalGet(id, key, options)
	})

storageLocal
	.command('set')
	.argument('[id]', 'Watcher id')
	.argument('<key>', 'localStorage key to set')
	.argument('<value>', 'Value to store')
	.option('--origin <origin>', 'Validate page origin matches this value')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus storage local set app myKey "myValue"\n  $ argus storage local set app config \'{"debug":true}\'\n')
	.action(async (id, key, value, options) => {
		await runStorageLocalSet(id, key, value, options)
	})

storageLocal
	.command('remove')
	.argument('[id]', 'Watcher id')
	.argument('<key>', 'localStorage key to remove')
	.option('--origin <origin>', 'Validate page origin matches this value')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus storage local remove app myKey\n')
	.action(async (id, key, options) => {
		await runStorageLocalRemove(id, key, options)
	})

storageLocal
	.command('ls')
	.alias('list')
	.argument('[id]', 'Watcher id')
	.option('--origin <origin>', 'Validate page origin matches this value')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus storage local ls app\n  $ argus storage local ls app --json\n')
	.action(async (id, options) => {
		await runStorageLocalList(id, options)
	})

storageLocal
	.command('clear')
	.argument('[id]', 'Watcher id')
	.option('--origin <origin>', 'Validate page origin matches this value')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus storage local clear app\n')
	.action(async (id, options) => {
		await runStorageLocalClear(id, options)
	})

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

program
	.command('screenshot')
	.argument('[id]', 'Watcher id to query')
	.description('Capture a screenshot to disk on the watcher')
	.option('--out <file>', 'Output file path (absolute or relative to artifacts directory)')
	.option('--selector <selector>', 'Optional CSS selector for element-only capture')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus screenshot app\n  $ argus screenshot app --out /tmp/screenshot.png\n  $ argus screenshot app --selector "body"\n',
	)
	.action(async (id, options) => {
		await runScreenshot(id, options)
	})

program
	.command('snapshot')
	.alias('snap')
	.alias('ax')
	.argument('[id]', 'Watcher id to query')
	.description('Capture an accessibility tree snapshot of the page')
	.option('--selector <css>', 'Scope snapshot to a DOM subtree')
	.option('--depth <n>', 'Max tree depth')
	.option('-i, --interactive', 'Only show interactive elements (buttons, links, inputs, etc.)')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nExamples:\n  $ argus snapshot app\n  $ argus snapshot app --interactive\n  $ argus snapshot app --selector "form"\n  $ argus snapshot app --depth 3\n  $ argus snap app -i\n  $ argus ax app\n',
	)
	.action(async (id, options) => {
		await runSnapshot(id, options)
	})

const trace = program
	.command('trace')
	.argument('[id]', 'Watcher id to query')
	.description('Capture a Chrome trace to disk on the watcher')
	.option('--duration <duration>', 'Capture for duration (e.g. 3s, 500ms)')
	.option('--out <file>', 'Output trace file path (relative to artifacts base directory)')
	.option('--categories <categories>', 'Comma-separated tracing categories')
	.option('--options <options>', 'Tracing options string')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace app --duration 3s --out trace.json\n')
	.action(async (id, options) => {
		await runTrace(id, options)
	})

trace
	.command('start')
	.argument('[id]', 'Watcher id to query')
	.description('Start Chrome tracing')
	.option('--out <file>', 'Output trace file path (relative to artifacts base directory)')
	.option('--categories <categories>', 'Comma-separated tracing categories')
	.option('--options <options>', 'Tracing options string')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace start app --out trace.json\n')
	.action(async (id, options) => {
		await runTraceStart(id, options)
	})

trace
	.command('stop')
	.argument('[id]', 'Watcher id to query')
	.description('Stop Chrome tracing')
	.option('--trace-id <id>', 'Trace id returned from start')
	.option('--json', 'Output JSON for automation')
	.addHelpText('after', '\nExamples:\n  $ argus trace stop app\n')
	.action(async (id, options) => {
		await runTraceStop(id, options)
	})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = program.command('config').alias('cfg').description('Manage Argus config files')

config
	.command('init')
	.description('Create an Argus config file')
	.option('--path <file>', 'Path to write the config file (default: .argus/config.json)')
	.option('--force', 'Overwrite existing config file')
	.addHelpText('after', '\nExamples:\n  $ argus config init\n  $ argus config init --path argus.config.json\n')
	.action(async (options) => {
		await runConfigInit(options)
	})

const extension = program.command('extension').alias('ext').description('Browser extension management')

extension
	.command('setup <extensionId>')
	.description('Install native messaging host for the browser extension')
	.option('--json', 'Output JSON for automation')
	.addHelpText(
		'after',
		'\nTo get your extension ID:\n  1. Open chrome://extensions\n  2. Enable Developer mode\n  3. Load argus-extension as unpacked\n  4. Copy the ID from the extension card\n',
	)
	.action(async (extensionId, options) => {
		await runExtensionSetup({ extensionId, ...options })
	})

extension
	.command('remove')
	.description('Uninstall native messaging host')
	.option('--json', 'Output JSON for automation')
	.action(async (options) => {
		await runExtensionRemove(options)
	})

extension
	.command('status')
	.description('Check native messaging host configuration')
	.option('--json', 'Output JSON for automation')
	.action(async (options) => {
		await runExtensionStatus(options)
	})

extension
	.command('info')
	.description('Show native messaging host paths and configuration')
	.option('--json', 'Output JSON for automation')
	.action(async (options) => {
		await runExtensionInfo(options)
	})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const cwd = process.cwd()
	const configPath = resolveArgusConfigPath({ cwd })
	const configResult = configPath ? loadArgusConfig(configPath) : null
	const config = configResult?.config ?? {}
	const configDir = configResult?.configDir ?? cwd

	const registry = new PluginRegistry()
	try {
		await registry.loadFromConfig(config, {
			cwd,
			configDir,
			argusConfig: config,
		})
		registry.registerWith(program)
	} catch (error) {
		console.error('Plugin loading failed:', error)
		process.exit(1)
	}

	const cleanup = async (): Promise<void> => {
		await registry.cleanup()
	}
	process.on('exit', () => void cleanup())
	process.on('SIGINT', () => void cleanup())
	process.on('SIGTERM', () => void cleanup())

	await program.parseAsync(process.argv)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
