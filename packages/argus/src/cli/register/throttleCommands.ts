import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runThrottleSet = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleSet))
const runThrottleClear = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleClear))
const runThrottleStatus = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleStatus))
const runThrottleNetSet = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleNetSet))
const runThrottleNetClear = lazyAction(() => import('../../commands/throttle.js').then((mod) => mod.runThrottleNetClear))

const throttleNetCommand: ArgusCommandDefinition = {
	name: 'net',
	description: 'Network throttling: latency, throughput caps, offline',
	subcommands: [
		{
			name: 'set',
			description: 'Throttle the page network until cleared (survives reloads, navigations, and re-attach)',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [
				{ flags: '--preset <name>', description: 'Named conditions: fast-4g, slow-4g, 3g, offline' },
				{ flags: '--latency <ms>', description: 'Latency added to every request, in milliseconds' },
				{ flags: '--down <kbps>', description: 'Download cap in kilobits per second' },
				{ flags: '--up <kbps>', description: 'Upload cap in kilobits per second' },
				jsonOption,
			],
			examples: [
				'argus throttle net set app --preset slow-4g',
				'argus throttle net set app --preset offline',
				'argus throttle net set app --latency 300 --down 1500 --up 750',
				'argus throttle net set app --preset 3g --latency 500     # preset with one value overridden',
				'argus throttle net set app --preset fast-4g --json',
			],
			action: async (id, options) => {
				await runThrottleNetSet(id, options)
			},
		},
		{
			name: 'clear',
			description: 'Restore normal network conditions',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [jsonOption],
			examples: ['argus throttle net clear app', 'argus throttle net clear app --json'],
			action: async (id, options) => {
				await runThrottleNetClear(id, options)
			},
		},
	],
}

export const throttleCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'throttle',
		description: 'CPU and network throttling',
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
				description: 'Show current CPU and network throttle state',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [jsonOption],
				examples: ['argus throttle status app', 'argus throttle status app --json'],
				action: async (id, options) => {
					await runThrottleStatus(id, options)
				},
			},
			throttleNetCommand,
		],
	},
]
