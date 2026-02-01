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
}
