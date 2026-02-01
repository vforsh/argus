import type { Command } from 'commander'
import { runLogs } from '../../commands/logs.js'
import { runTail } from '../../commands/tail.js'
import { collectMatch, validateCaseFlags, validateMatchOptions } from '../validation.js'

export function registerLogs(program: Command): void {
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
}
