import type { Command } from 'commander'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runTrace, runTraceStart, runTraceStop } from '../../commands/trace.js'

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
			{ flags: '--json', description: 'Output JSON for automation' },
		],
		examples: ['argus trace app --duration 3s --out trace.json'],
		action: async (id, options, command) => {
			await runTrace(id, resolveActionOptions(options, command))
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
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: ['argus trace start app --out trace.json'],
				action: async (id, options, command) => {
					await runTraceStart(id, resolveActionOptions(options, command))
				},
			},
			{
				name: 'stop',
				description: 'Stop Chrome tracing',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--trace-id <id>', description: 'Trace id returned from start' },
					{ flags: '--out <file>', description: 'Move the saved trace file to this path before returning' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: ['argus trace stop app', 'argus trace stop app --out trace.json --json'],
				action: async (id, options, command) => {
					await runTraceStop(id, resolveActionOptions(options, command))
				},
			},
		],
	},
]

/**
 * `trace` is both a command and a subcommand parent, so Commander may pass
 * either (options, command) or just the command. Merge parent + own opts.
 */
function resolveActionOptions(options: Record<string, unknown>, command: Command | undefined): Record<string, unknown> {
	const maybeCommand = options as unknown as Command | undefined
	if (typeof maybeCommand?.opts === 'function') {
		return {
			...(typeof maybeCommand.parent?.opts === 'function' ? maybeCommand.parent.opts() : {}),
			...maybeCommand.opts(),
		}
	}

	if (typeof command?.opts === 'function') {
		return {
			...(typeof command.parent?.opts === 'function' ? command.parent.opts() : {}),
			...command.opts(),
			...options,
		}
	}

	return options
}
