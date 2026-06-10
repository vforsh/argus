import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { runLogs } from '../../commands/logs.js'
import { runTail } from '../../commands/tail.js'
import { collectMatch, validateCaseFlags, validateMatchOptions } from '../validation.js'

const sharedFilterOptions: readonly ArgusCommandOption[] = [
	{ flags: '--levels <levels>', description: 'Comma-separated log levels' },
	{ flags: '--match <regex>', description: 'Filter by regex (repeatable)', parser: collectMatch, defaultValue: [] },
	{ flags: '--ignore-case', description: 'Use case-insensitive regex matching' },
	{ flags: '--case-sensitive', description: 'Use case-sensitive regex matching' },
	{ flags: '--source <pattern>', description: 'Filter by source substring' },
]

const validateLogsOptions = (options: {
	json?: boolean
	jsonFull?: boolean
	ignoreCase?: boolean
	caseSensitive?: boolean
	match?: string[]
}): boolean => {
	if (options.json && options.jsonFull) {
		console.error('Cannot combine --json with --json-full.')
		process.exitCode = 2
		return false
	}
	return validateCaseFlags(options) && validateMatchOptions(options)
}

export const logsCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'logs',
		alias: 'log',
		description: 'Fetch recent logs from a watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			...sharedFilterOptions,
			{ flags: '--since <duration>', description: 'Filter by time window (e.g. 10m, 2h, 30s)' },
			{ flags: '--after <id>', description: 'Only return events after this id' },
			{ flags: '--limit <count>', description: 'Maximum number of events' },
			{ flags: '--json', description: 'Output bounded JSON preview for automation' },
			{ flags: '--json-full', description: 'Output full JSON (can be very large)' },
		],
		examples: ['argus logs app', 'argus logs app --since 10m --levels error,warning', 'argus logs app --json', 'argus logs app --json-full'],
		action: async (id, options) => {
			if (!validateLogsOptions(options)) return
			await runLogs(id, options)
		},
		subcommands: [
			{
				name: 'tail',
				description: 'Stream logs via long-polling',
				arguments: [{ flags: '[id]', description: 'Watcher id to follow' }],
				options: [
					...sharedFilterOptions,
					{ flags: '--after <id>', description: 'Start after this event id' },
					{ flags: '--limit <count>', description: 'Maximum number of events per poll' },
					{ flags: '--timeout <ms>', description: 'Long-poll timeout in milliseconds' },
					{ flags: '--json', description: 'Output bounded newline-delimited JSON events' },
					{ flags: '--json-full', description: 'Output full newline-delimited JSON events (can be very large)' },
				],
				examples: [
					'argus logs tail app',
					'argus logs tail app --levels error',
					'argus logs tail app --json',
					'argus logs tail app --json-full',
				],
				action: async (id, options) => {
					if (!validateLogsOptions(options)) return
					await runTail(id, options)
				},
			},
		],
	},
]
