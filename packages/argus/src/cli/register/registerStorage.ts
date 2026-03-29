import type { Command } from 'commander'
import type { StorageArea } from '@vforsh/argus-core'
import { runStorageClear, runStorageGet, runStorageList, runStorageRemove, runStorageSet } from '../../commands/storage.js'

export function registerStorage(program: Command): void {
	const storage = program.command('storage').description('Interact with browser storage APIs')

	registerStorageArea(storage, 'local')
	registerStorageArea(storage, 'session')
}

const registerStorageArea = (storage: Command, area: StorageArea): void => {
	const storageName = `${area}Storage`
	const storageArea = storage.command(area).description(`Manage ${storageName} for the attached page`)

	storageArea
		.command('get')
		.argument('[id]', 'Watcher id')
		.argument('<key>', `${storageName} key to retrieve`)
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', `\nExamples:\n  $ argus storage ${area} get app myKey\n  $ argus storage ${area} get app myKey --json\n`)
		.action(async (id, key, options) => {
			await runStorageGet(area, id, key, options)
		})

	storageArea
		.command('set')
		.argument('[id]', 'Watcher id')
		.argument('<key>', `${storageName} key to set`)
		.argument('<value>', 'Value to store')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			`\nExamples:\n  $ argus storage ${area} set app myKey "myValue"\n  $ argus storage ${area} set app config '{"debug":true}'\n`,
		)
		.action(async (id, key, value, options) => {
			await runStorageSet(area, id, key, value, options)
		})

	storageArea
		.command('remove')
		.argument('[id]', 'Watcher id')
		.argument('<key>', `${storageName} key to remove`)
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', `\nExamples:\n  $ argus storage ${area} remove app myKey\n`)
		.action(async (id, key, options) => {
			await runStorageRemove(area, id, key, options)
		})

	storageArea
		.command('ls')
		.alias('list')
		.argument('[id]', 'Watcher id')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', `\nExamples:\n  $ argus storage ${area} ls app\n  $ argus storage ${area} ls app --json\n`)
		.action(async (id, options) => {
			await runStorageList(area, id, options)
		})

	storageArea
		.command('clear')
		.argument('[id]', 'Watcher id')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', `\nExamples:\n  $ argus storage ${area} clear app\n`)
		.action(async (id, options) => {
			await runStorageClear(area, id, options)
		})
}
