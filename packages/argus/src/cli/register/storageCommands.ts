import type { StorageArea } from '@vforsh/argus-core'
import type { ArgusCommandDefinition } from '../defineCommand.js'
import { ORIGIN_STORAGE_TYPES } from '@vforsh/argus-core'
import { actionOptions, jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runStorageClear = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageClear))
const runStorageGet = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageGet))
const runStorageList = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageList))
const runStorageRemove = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageRemove))
const runStorageSet = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageSet))

const runStorageClearOrigin = lazyAction(() => import('../../commands/storage.js').then((mod) => mod.runStorageClearOrigin))
const runIndexedDbList = lazyAction(() => import('../../commands/storageIndexedDb.js').then((mod) => mod.runIndexedDbList))
const runIndexedDbGet = lazyAction(() => import('../../commands/storageIndexedDb.js').then((mod) => mod.runIndexedDbGet))
const runIndexedDbClear = lazyAction(() => import('../../commands/storageIndexedDb.js').then((mod) => mod.runIndexedDbClear))
const runIndexedDbDelete = lazyAction(() => import('../../commands/storageIndexedDb.js').then((mod) => mod.runIndexedDbDelete))

const sharedOptions = [
	{ flags: '--origin <origin>', description: 'Validate page origin matches this value' },
	jsonOption,
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

const indexedDbCommand: ArgusCommandDefinition = {
	name: 'indexeddb',
	alias: 'idb',
	description: "Inspect and reset IndexedDB for the attached page's origin",
	subcommands: [
		{
			name: 'ls',
			alias: 'list',
			description: 'List databases (name, version) and their object stores with entry counts',
			arguments: [{ flags: '[id]', description: 'Watcher id' }],
			options: sharedOptions,
			examples: ['argus storage idb ls app', 'argus storage idb ls app --json'],
			action: async (id, options) => {
				await runIndexedDbList(id, options)
			},
		},
		{
			name: 'get',
			description: 'Read entries from an object store (one "<key>\t<value>" JSON line each)',
			arguments: [
				{ flags: '[id]', description: 'Watcher id' },
				{ flags: '<db>', description: 'Database name' },
				{ flags: '<store>', description: 'Object store name' },
			],
			options: [
				{ flags: '--key <key>', description: 'Only the entry with this primary key (JSON number/array, or string; force a string with \'"42"\')' },
				{ flags: '--limit <n>', description: 'Max entries (1-1000, default 50)' },
				{ flags: '--skip <n>', description: 'Entries to skip before the page starts (default 0)' },
				...sharedOptions,
			],
			examples: [
				'argus storage idb get app save slots',
				'argus storage idb get app save slots --key 1 --json',
				'argus storage idb get app save slots --limit 100 --skip 100',
			],
			action: async (id, database, store, options) => {
				await runIndexedDbGet(id, database, store, options)
			},
		},
		{
			name: 'clear',
			description: 'Clear one object store, or every store in the database when [store] is omitted',
			arguments: [
				{ flags: '[id]', description: 'Watcher id' },
				{ flags: '<db>', description: 'Database name' },
				{ flags: '[store]', description: 'Object store name (omit to clear all stores)' },
			],
			options: sharedOptions,
			examples: ['argus storage idb clear app save slots', 'argus storage idb clear app save'],
			action: async (id, database, store, options) => {
				await runIndexedDbClear(id, database, store, options)
			},
		},
		{
			name: 'delete',
			description: 'Delete a database, even while the page holds it open (Chrome force-closes its connections). CDP watchers only',
			arguments: [
				{ flags: '[id]', description: 'Watcher id' },
				{ flags: '<db>', description: 'Database name' },
			],
			options: sharedOptions,
			examples: ['argus storage idb delete app save', 'argus storage idb delete app save && argus reload app'],
			action: async (id, database, options) => {
				await runIndexedDbDelete(id, database, options)
			},
		},
	],
}

const clearOriginCommand: ArgusCommandDefinition = {
	name: 'clear',
	description: "Clear the attached page's origin data (IndexedDB, local/session storage, cookies, Cache Storage, service workers, …)",
	arguments: [{ flags: '[id]', description: 'Watcher id' }],
	options: [
		{ flags: '--types <list>', description: `Comma-separated types (default all): ${ORIGIN_STORAGE_TYPES.join(', ')}` },
		{ flags: '--reload', description: 'Reload the page after clearing, so it boots from empty storage' },
		...sharedOptions,
		...actionOptions,
	],
	examples: [
		'argus storage clear app --reload',
		'argus storage clear app --types indexeddb,local_storage',
		'argus storage clear app --reload --until "window.game?.ready" --until-timeout 60s',
	],
	action: async (id, options) => {
		await runStorageClearOrigin(id, options)
	},
}

export const storageCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'storage',
		description: 'Interact with browser storage APIs',
		subcommands: [storageAreaCommand('local'), storageAreaCommand('session'), indexedDbCommand, clearOriginCommand],
	},
]
