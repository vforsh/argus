import type { Command } from 'commander'
import { runCodeGrep, runCodeList, runCodeRead } from '../../commands/code.js'

export function registerCode(program: Command): void {
	const code = program.command('code').description('Inspect runtime JS/CSS resources')

	code.command('ls')
		.alias('list')
		.argument('[id]', 'Watcher id to query')
		.option('--pattern <substring>', 'Case-insensitive substring filter over resource URLs')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus code ls playground\n  $ argus code ls playground --pattern index\n')
		.action(async (id, options) => {
			await runCodeList(id, options)
		})

	code.command('read')
		.argument('<url>', 'Runtime resource URL from `argus code ls`')
		.option('--id <watcherId>', 'Watcher id to query')
		.option('--offset <n>', 'Zero-based line offset')
		.option('--limit <n>', 'Max number of lines to return')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus code read http://127.0.0.1:3333/ --id playground\n  $ argus code read inline://123 --id playground --offset 50 --limit 80\n',
		)
		.action(async (url, options) => {
			await runCodeRead(options.id, url, options)
		})

	code.command('grep')
		.argument('<pattern>', 'Plain string or /regex/flags pattern')
		.option('--id <watcherId>', 'Watcher id to query')
		.option('--url <substring>', 'Limit search to resource URLs containing this substring')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			"\nExamples:\n  $ argus code grep playground --id playground\n  $ argus code grep '/window\\\\.playground/' --id playground --url index\n",
		)
		.action(async (pattern, options) => {
			await runCodeGrep(options.id, pattern, options)
		})
}
