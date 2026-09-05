import type { ArgusCommandDefinition } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { runRecord, runRecordStart, runRecordStatus, runRecordStop } from '../../commands/record.js'
import { jsonOption } from './sharedOptions.js'

const outOption = {
	flags: '--out <file>',
	description: 'Output .mp4, .webm, or .gif path (absolute, or relative to the current working directory)',
}

const captureOptions = [
	{ flags: '--selector <selector>', description: 'Optional CSS selector for element-only recording' },
	{ flags: '--clip <x,y,width,height>', description: 'Viewport-relative rectangle crop in CSS pixels' },
	{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
	{ flags: '--fps <n>', description: 'Output frames per second (1-60, default 30; GIF defaults to 12 and caps at 20)' },
	{ flags: '--format <format>', description: 'Output format: mp4, webm, or gif (default mp4, inferred from --out extension)' },
	{ flags: '--quality <n>', description: 'JPEG quality of captured frames (1-100, default 90)' },
]

export const recordCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'record',
		description: 'Capture a silent video recording to disk on the watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--duration <duration>', description: 'Capture for duration (e.g. 3s, 500ms)' },
			{ flags: '--until <expression>', description: 'Capture until this page expression is truthy (mutually exclusive with --duration)' },
			{ flags: '--max <duration>', description: 'Stop automatically after this long (default 60s with --until)' },
			{ flags: '--poll <duration>', description: 'Interval between --until evaluations (default 250ms)' },
			outOption,
			...captureOptions,
			jsonOption,
		],
		examples: [
			'argus record app --duration 5s --out demo.mp4',
			'argus record app --duration 3s --selector "canvas" --out canvas.mp4',
			'argus record app --duration 3s --clip 100,80,640,360 --out crop.mp4',
			'argus record app --duration 4s --out bug.gif',
			'argus record app --until "window.gameOver === true" --max 30s --out run.mp4',
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
					outOption,
					...captureOptions,
					{ flags: '--max <duration>', description: 'Stop automatically after this long (default 10m)' },
					jsonOption,
				],
				examples: ['argus record start app --selector "canvas" --out canvas.mp4', 'argus record start app --max 2m --out run.gif'],
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
					{
						flags: '--out <file>',
						description:
							'Move the saved recording to this .mp4, .webm, or .gif path (absolute, or relative to the current working directory)',
					},
					jsonOption,
				],
				examples: ['argus record stop app', 'argus record stop app --out demo.mp4 --json'],
				action: async (id, options) => {
					await runRecordStop(id, options)
				},
			},
			{
				name: 'status',
				description: 'Show the active video recording, if any',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [jsonOption],
				examples: ['argus record status app', 'argus record status app --json'],
				action: async (id, options) => {
					await runRecordStatus(id, options)
				},
			},
		],
	},
]
