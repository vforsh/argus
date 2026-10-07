import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runThrottleSet = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleSet))
const runThrottleClear = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleClear))
const runThrottleStatus = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleStatus))

export const throttleCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'throttle',
		description: 'CPU throttling',
		subcommands: [
			{
				name: 'set',
				description: 'Set CPU throttle rate',
				arguments: [
					{ flags: '[id]', description: 'Watcher ID' },
					{ flags: '<rate>', description: 'Throttle rate (1 = none, 4 = 4x slowdown)' },
				],
				options: [jsonOption],
				examples: [
					'argus throttle set app 4',
					'argus throttle set app 6',
					'argus throttle set app 1     # effectively disables',
					'argus throttle set app 4 --json',
				],
				action: async (id, rate, options) => {
					await runThrottleSet(id, rate, options)
				},
			},
			{
				name: 'clear',
				description: 'Clear CPU throttle',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [jsonOption],
				examples: ['argus throttle clear app', 'argus throttle clear app --json'],
				action: async (id, options) => {
					await runThrottleClear(id, options)
				},
			},
			{
				name: 'status',
				description: 'Show current CPU throttle state',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [jsonOption],
				examples: ['argus throttle status app', 'argus throttle status app --json'],
				action: async (id, options) => {
					await runThrottleStatus(id, options)
				},
			},
		],
	},
]
