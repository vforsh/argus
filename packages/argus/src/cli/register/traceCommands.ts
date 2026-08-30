import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runTrace, runTraceStart, runTraceStop } from '../../commands/trace.js'
import { jsonOption } from './sharedOptions.js'

export const traceCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'trace',
		description: 'Capture a Chrome trace to disk on the watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--duration <duration>', description: 'Capture for duration (e.g. 3s, 500ms)' },
			{ flags: '--out <file>', description: 'Output trace file path (relative to artifacts base directory)' },
			{ flags: '--categories <categories>', description: 'Comma-separated tracing categories' },
			{ flags: '--options <options>', description: 'Tracing options string' },
			jsonOption,
		],
		examples: ['argus trace app --duration 3s --out trace.json'],
		action: async (id, options) => {
			await runTrace(id, options)
		},
		subcommands: [
			{
				name: 'start',
				description: 'Start Chrome tracing',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--out <file>', description: 'Output trace file path (relative to artifacts base directory)' },
					{ flags: '--categories <categories>', description: 'Comma-separated tracing categories' },
					{ flags: '--options <options>', description: 'Tracing options string' },
					jsonOption,
				],
				examples: ['argus trace start app --out trace.json'],
				action: async (id, options) => {
					await runTraceStart(id, options)
				},
			},
			{
				name: 'stop',
				description: 'Stop Chrome tracing',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--trace-id <id>', description: 'Trace id returned from start' },
					{ flags: '--out <file>', description: 'Move the saved trace file to this path before returning' },
					jsonOption,
				],
				examples: ['argus trace stop app', 'argus trace stop app --out trace.json --json'],
				action: async (id, options) => {
					await runTraceStop(id, options)
				},
			},
		],
	},
]
