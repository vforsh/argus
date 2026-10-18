import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runTrace = lazyAction(() => import('../../commands/trace.js').then((mod) => mod.runTrace))
const runTraceStart = lazyAction(() => import('../../commands/trace.js').then((mod) => mod.runTraceStart))
const runTraceStop = lazyAction(() => import('../../commands/trace.js').then((mod) => mod.runTraceStop))
const runTraceAnalyze = lazyAction(() => import('../../commands/traceAnalyze.js').then((mod) => mod.runTraceAnalyze))

const presetOption = {
	flags: '--preset <name>',
	description: 'Category set: frames (presentation/latency/main frame), input (EventLatency), gpu; --categories are appended',
}

export const traceCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'trace',
		description: 'Capture a Chrome trace to disk on the watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--duration <duration>', description: 'Capture for duration (e.g. 3s, 500ms)' },
			{ flags: '--out <file>', description: 'Output trace file path (absolute, or relative to the current working directory)' },
			presetOption,
			{ flags: '--categories <categories>', description: 'Comma-separated tracing categories' },
			{ flags: '--options <options>', description: 'Tracing options string' },
			{
				flags: '--targets <ids>',
				description: 'Comma-separated watcher ids to trace together in one session, renderers labelled per watcher (CDP watchers only)',
			},
			jsonOption,
		],
		examples: [
			'argus trace app --duration 3s --out trace.json',
			'argus trace app --preset frames --duration 7s --out a.json',
			'argus trace --targets app,admin --duration 5s --out compare.json',
		],
		action: async (id, options) => {
			await runTrace(id, options)
		},
		subcommands: [
			{
				name: 'start',
				description: 'Start Chrome tracing',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--out <file>', description: 'Output trace file path (absolute, or relative to the current working directory)' },
					presetOption,
					{ flags: '--categories <categories>', description: 'Comma-separated tracing categories' },
					{ flags: '--options <options>', description: 'Tracing options string' },
					jsonOption,
				],
				examples: ['argus trace start app --out trace.json', 'argus trace start app --preset input --out input.json'],
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
					{
						flags: '--out <file>',
						description: 'Move the saved trace file to this path (absolute, or relative to the current working directory)',
					},
					jsonOption,
				],
				examples: ['argus trace stop app', 'argus trace stop app --out trace.json --json'],
				action: async (id, options) => {
					await runTraceStop(id, options)
				},
			},
			{
				name: 'analyze',
				description: 'Stream a trace file: presentation states and stages (frames), EventLatency by type (input)',
				arguments: [
					{ flags: '<file>', description: 'Chrome trace JSON' },
					{ flags: '[analyzer]', description: 'frames or input (default: both)' },
				],
				options: [
					{ flags: '--pid <pid>', description: 'Renderer process (default: the one with the most BeginMainFrame events)' },
					{ flags: '--out <file>', description: 'Write the run result JSON (for `argus perf compare`)' },
					jsonOption,
				],
				examples: ['argus trace analyze a.json frames', 'argus trace analyze a.json input --json'],
				action: async (file, analyzer, options) => {
					await runTraceAnalyze(file, analyzer, options)
				},
			},
		],
	},
]
