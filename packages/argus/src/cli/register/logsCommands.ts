import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { runLogCursor, runLogEpoch, runLogs } from '../../commands/logs.js'
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
			{ flags: '--after <cursor>', description: 'Only return events after this opaque cursor' },
			{ flags: '--since-epoch <epoch>', description: 'Only return events after this opaque epoch' },
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
				name: 'epoch',
				description: 'Return an opaque watcher-session log epoch without downloading events',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [{ flags: '--json', description: 'Output one JSON document for automation' }],
				examples: ['argus logs epoch app', 'argus logs epoch app --json'],
				action: async (id, options, command) => {
					await runLogEpoch(id, command.optsWithGlobals?.() ?? options)
				},
			},
			{
				name: 'cursor',
				description: 'Return the current log cursor without downloading events',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [{ flags: '--json', description: 'Output one JSON document for automation' }],
				examples: ['argus logs cursor app', 'argus logs cursor app --json'],
				action: async (id, options, command) => {
					await runLogCursor(id, command.optsWithGlobals?.() ?? options)
				},
			},
			{
				name: 'tail',
				description: 'Stream logs via long-polling',
				arguments: [{ flags: '[id]', description: 'Watcher id to follow' }],
				options: [
					...sharedFilterOptions,
					{ flags: '--after <cursor>', description: 'Start after this opaque cursor' },
					{ flags: '--since-epoch <epoch>', description: 'Start after this opaque epoch' },
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
				action: async (id, options, command) => {
					const resolvedOptions = command.optsWithGlobals?.() ?? options
					if (!validateLogsOptions(resolvedOptions)) return
					await runTail(id, resolvedOptions)
				},
			},
		],
	},
]
