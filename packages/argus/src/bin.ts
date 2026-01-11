#!/usr/bin/env node
import { Command } from 'commander'
import { runList } from './commands/list.js'
import { runLogs } from './commands/logs.js'
import { runTail } from './commands/tail.js'

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

program
	.command('list')
	.description('List registered watchers')
	.option('--json', 'Output JSON for automation')
	.option('--by-cwd <substring>', 'Filter watchers by working directory substring')
	.addHelpText('after', '\nExamples:\n  $ argus list\n  $ argus list --json\n  $ argus list --by-cwd my-project\n')
	.action(async (options) => {
		await runList(options)
	})

program
	.command('logs')
	.argument('<id>', 'Watcher id to query')
	.description('Fetch recent logs from a watcher')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--grep <text>', 'Filter by substring')
	.option('--since <duration>', 'Filter by time window (e.g. 10m, 2h, 30s)')
	.option('--after <id>', 'Only return events after this id')
	.option('--limit <count>', 'Maximum number of events')
	.option('--json', 'Output bounded JSON preview for automation')
	.option('--json-full', 'Output full JSON (can be very large)')
	.addHelpText('after', '\nExamples:\n  $ argus logs app\n  $ argus logs app --since 10m --levels error,warning\n  $ argus logs app --json\n  $ argus logs app --json-full\n')
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		await runLogs(id, options)
	})

program
	.command('tail')
	.argument('<id>', 'Watcher id to follow')
	.description('Tail logs from a watcher via long-polling')
	.option('--levels <levels>', 'Comma-separated log levels')
	.option('--grep <text>', 'Filter by substring')
	.option('--after <id>', 'Start after this event id')
	.option('--limit <count>', 'Maximum number of events per poll')
	.option('--timeout <ms>', 'Long-poll timeout in milliseconds')
	.option('--json', 'Output bounded newline-delimited JSON events')
	.option('--json-full', 'Output full newline-delimited JSON events (can be very large)')
	.addHelpText('after', '\nExamples:\n  $ argus tail app\n  $ argus tail app --levels error\n  $ argus tail app --json\n  $ argus tail app --json-full\n')
	.action(async (id, options) => {
		if (options.json && options.jsonFull) {
			console.error('Cannot combine --json with --json-full.')
			process.exitCode = 2
			return
		}
		await runTail(id, options)
	})

program.parseAsync(process.argv)
