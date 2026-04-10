import type { Command } from 'commander'
import { runCodeDeminify, runCodeGrep, runCodeList, runCodeRead, runCodeStrings } from '../../commands/code.js'
import { runCodeEdit } from '../../commands/codeEdit.js'

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
		.option('--pretty', 'Render compact context snippets for human output')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			"\nExamples:\n  $ argus code grep playground --id playground\n  $ argus code grep '/window\\\\.playground/' --id playground --url index\n  $ argus code grep showLogsByHost --id playground --pretty\n",
		)
		.action(async (pattern, options) => {
			await runCodeGrep(options.id, pattern, options)
		})

	code.command('deminify')
		.argument('<url>', 'Runtime resource URL from `argus code ls`')
		.option('--id <watcherId>', 'Watcher id to query')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus code deminify http://127.0.0.1:3333/app.js --id playground\n  $ argus code deminify inline://42 --id playground --json\n',
		)
		.action(async (url, options) => {
			await runCodeDeminify(options.id, url, options)
		})

	code.command('edit')
		.argument('<url>', 'Runtime resource URL from `argus code ls`')
		.option('--id <watcherId>', 'Watcher id to query')
		.option('--file <path>', 'Read replacement source from a file')
		.option('--search <pattern>', 'Plain string or /regex/flags to find in the existing source')
		.option('--replace <text>', 'Replacement text (required with --search)')
		.option('--all', 'Replace all occurrences (with --search/--replace)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			[
				'\nExamples:',
				'  $ argus code edit http://127.0.0.1:3333/app.js --id playground --search "DEBUG=false" --replace "DEBUG=true"',
				'  $ argus code edit http://127.0.0.1:3333/app.js --id playground --file ./patched.js',
				'  $ cat patched.css | argus code edit inline-css://1 --id playground',
				'',
			].join('\n'),
		)
		.action(async (url, options) => {
			await runCodeEdit(options.id, url, options)
		})

	code.command('strings')
		.argument('[id]', 'Watcher id to query')
		.option('--url <substring>', 'Limit extraction to resource URLs containing this substring')
		.option('--min-length <n>', 'Minimum string length to include (default: 8)')
		.option('--limit <n>', 'Maximum number of strings to emit (default: 200)')
		.option('--kind <list>', 'Comma-separated kinds: url,key,identifier,message,other')
		.option('--match <pattern>', 'Filter string values by plain text or /regex/flags pattern')
		.option('--all', 'Include low-signal strings instead of only interesting ones')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			"\nExamples:\n  $ argus code strings playground\n  $ argus code strings playground --url app.js --kind url,identifier\n  $ argus code strings playground --match '/admin\\/api/'\n  $ argus code strings playground --all --min-length 4\n",
		)
		.action(async (id, options) => {
			await runCodeStrings(id, options)
		})
}
