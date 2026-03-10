import type { Command } from 'commander'
import { runTrace, runTraceStart, runTraceStop } from '../../commands/trace.js'

export function registerTrace(program: Command): void {
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
		.action(async (id, options, command) => {
			await runTrace(id, resolveActionOptions(options, command))
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
		.action(async (id, options, command) => {
			await runTraceStart(id, resolveActionOptions(options, command))
		})

	trace
		.command('stop')
		.argument('[id]', 'Watcher id to query')
		.description('Stop Chrome tracing')
		.option('--trace-id <id>', 'Trace id returned from start')
		.option('--out <file>', 'Move the saved trace file to this path before returning')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus trace stop app\n  $ argus trace stop app --out trace.json --json\n')
		.action(async (id, options, command) => {
			await runTraceStop(id, resolveActionOptions(options, command))
		})
}

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
