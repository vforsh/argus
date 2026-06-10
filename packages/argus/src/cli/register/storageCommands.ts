import type { StorageArea } from '@vforsh/argus-core'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runStorageClear, runStorageGet, runStorageList, runStorageRemove, runStorageSet } from '../../commands/storage.js'

const sharedOptions = [
	{ flags: '--origin <origin>', description: 'Validate page origin matches this value' },
	{ flags: '--json', description: 'Output JSON for automation' },
] as const

const storageAreaCommand = (area: StorageArea): ArgusCommandDefinition => {
	const storageName = `${area}Storage`
	return {
		name: area,
		description: `Manage ${storageName} for the attached page`,
		subcommands: [
			{
				name: 'get',
				arguments: [
					{ flags: '[id]', description: 'Watcher id' },
					{ flags: '<key>', description: `${storageName} key to retrieve` },
				],
				options: sharedOptions,
				examples: [`argus storage ${area} get app myKey`, `argus storage ${area} get app myKey --json`],
				action: async (id, key, options) => {
					await runStorageGet(area, id, key, options)
				},
			},
			{
				name: 'set',
				arguments: [
					{ flags: '[id]', description: 'Watcher id' },
					{ flags: '<key>', description: `${storageName} key to set` },
					{ flags: '<value>', description: 'Value to store' },
				],
				options: sharedOptions,
				examples: [`argus storage ${area} set app myKey "myValue"`, `argus storage ${area} set app config '{"debug":true}'`],
				action: async (id, key, value, options) => {
					await runStorageSet(area, id, key, value, options)
				},
			},
			{
				name: 'remove',
				arguments: [
					{ flags: '[id]', description: 'Watcher id' },
					{ flags: '<key>', description: `${storageName} key to remove` },
				],
				options: sharedOptions,
				examples: [`argus storage ${area} remove app myKey`],
				action: async (id, key, options) => {
					await runStorageRemove(area, id, key, options)
				},
			},
			{
				name: 'ls',
				alias: 'list',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: sharedOptions,
				examples: [`argus storage ${area} ls app`, `argus storage ${area} ls app --json`],
				action: async (id, options) => {
					await runStorageList(area, id, options)
				},
			},
			{
				name: 'clear',
				arguments: [{ flags: '[id]', description: 'Watcher id' }],
				options: sharedOptions,
				examples: [`argus storage ${area} clear app`],
				action: async (id, options) => {
					await runStorageClear(area, id, options)
				},
			},
		],
	}
}

export const storageCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'storage',
		description: 'Interact with browser storage APIs',
		subcommands: [storageAreaCommand('local'), storageAreaCommand('session')],
	},
]
