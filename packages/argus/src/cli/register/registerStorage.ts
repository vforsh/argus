import type { Command } from 'commander'
import {
	runStorageLocalGet,
	runStorageLocalSet,
	runStorageLocalRemove,
	runStorageLocalList,
	runStorageLocalClear,
} from '../../commands/storageLocal.js'

export function registerStorage(program: Command): void {
	const storage = program.command('storage').description('Interact with browser storage APIs')
	const storageLocal = storage.command('local').description('Manage localStorage for the attached page')

	storageLocal
		.command('get')
		.argument('[id]', 'Watcher id')
		.argument('<key>', 'localStorage key to retrieve')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus storage local get app myKey\n  $ argus storage local get app myKey --json\n')
		.action(async (id, key, options) => {
			await runStorageLocalGet(id, key, options)
		})

	storageLocal
		.command('set')
		.argument('[id]', 'Watcher id')
		.argument('<key>', 'localStorage key to set')
		.argument('<value>', 'Value to store')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus storage local set app myKey "myValue"\n  $ argus storage local set app config \'{"debug":true}\'\n',
		)
		.action(async (id, key, value, options) => {
			await runStorageLocalSet(id, key, value, options)
		})

	storageLocal
		.command('remove')
		.argument('[id]', 'Watcher id')
		.argument('<key>', 'localStorage key to remove')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus storage local remove app myKey\n')
		.action(async (id, key, options) => {
			await runStorageLocalRemove(id, key, options)
		})

	storageLocal
		.command('ls')
		.alias('list')
		.argument('[id]', 'Watcher id')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus storage local ls app\n  $ argus storage local ls app --json\n')
		.action(async (id, options) => {
			await runStorageLocalList(id, options)
		})

	storageLocal
		.command('clear')
		.argument('[id]', 'Watcher id')
		.option('--origin <origin>', 'Validate page origin matches this value')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus storage local clear app\n')
		.action(async (id, options) => {
			await runStorageLocalClear(id, options)
		})
}
