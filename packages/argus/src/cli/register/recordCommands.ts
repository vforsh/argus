import type { ArgusCommandDefinition } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { runRecord, runRecordStart, runRecordStop } from '../../commands/record.js'
import { jsonOption } from './sharedOptions.js'

export const recordCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'record',
		description: 'Capture a silent video recording to disk on the watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--duration <duration>', description: 'Capture for duration (e.g. 3s, 500ms)' },
			{ flags: '--out <file>', description: 'Output .mp4 or .webm path (absolute or relative to artifacts directory)' },
			{ flags: '--selector <selector>', description: 'Optional CSS selector for element-only recording' },
			{ flags: '--clip <x,y,width,height>', description: 'Viewport-relative rectangle crop in CSS pixels' },
			{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
			{ flags: '--fps <n>', description: 'Output frames per second (1-60, default 30)' },
			{ flags: '--format <format>', description: 'Output format: mp4 or webm (default mp4, inferred from --out extension)' },
			jsonOption,
		],
		examples: [
			'argus record app --duration 5s --out demo.mp4',
			'argus record app --duration 3s --selector "canvas" --out canvas.mp4',
			'argus record app --duration 3s --clip 100,80,640,360 --out crop.mp4',
			'argus record app --duration 3s --format webm --out canvas.webm',
		],
		action: async (id, options) => {
			if (!resolveTestId(options)) return
			await runRecord(id, options)
		},
		subcommands: [
			{
				name: 'start',
				description: 'Start a silent video recording',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--out <file>', description: 'Output .mp4 or .webm path (absolute or relative to artifacts directory)' },
					{ flags: '--selector <selector>', description: 'Optional CSS selector for element-only recording' },
					{ flags: '--clip <x,y,width,height>', description: 'Viewport-relative rectangle crop in CSS pixels' },
					{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
					{ flags: '--fps <n>', description: 'Output frames per second (1-60, default 30)' },
					{ flags: '--format <format>', description: 'Output format: mp4 or webm (default mp4, inferred from --out extension)' },
					jsonOption,
				],
				examples: ['argus record start app --selector "canvas" --out canvas.mp4'],
				action: async (id, options) => {
					if (!resolveTestId(options)) return
					await runRecordStart(id, options)
				},
			},
			{
				name: 'stop',
				description: 'Stop the active video recording',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--record-id <id>', description: 'Record id returned from start' },
					{ flags: '--out <file>', description: 'Move the saved recording to this .mp4 or .webm path before returning' },
					jsonOption,
				],
				examples: ['argus record stop app', 'argus record stop app --out demo.mp4 --json'],
				action: async (id, options) => {
					await runRecordStop(id, options)
				},
			},
		],
	},
]
