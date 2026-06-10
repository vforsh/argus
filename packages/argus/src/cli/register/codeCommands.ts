import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runCodeDeminify, runCodeGrep, runCodeList, runCodeRead, runCodeStrings } from '../../commands/code.js'
import { runCodeEdit } from '../../commands/codeEdit.js'

export const codeCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'code',
		description: 'Inspect runtime JS/CSS resources',
		subcommands: [
			{
				name: 'ls',
				alias: 'list',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--pattern <substring>', description: 'Case-insensitive substring filter over resource URLs' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: ['argus code ls playground', 'argus code ls playground --pattern index'],
				action: async (id, options) => {
					await runCodeList(id, options)
				},
			},
			{
				name: 'read',
				arguments: [{ flags: '<url>', description: 'Runtime resource URL from `argus code ls`' }],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query' },
					{ flags: '--offset <n>', description: 'Zero-based line offset' },
					{ flags: '--limit <n>', description: 'Max number of lines to return' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus code read http://127.0.0.1:3333/ --id playground',
					'argus code read inline://123 --id playground --offset 50 --limit 80',
				],
				action: async (url, options) => {
					await runCodeRead(options.id, url, options)
				},
			},
			{
				name: 'grep',
				arguments: [{ flags: '<pattern>', description: 'Plain string or /regex/flags pattern' }],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query' },
					{ flags: '--url <substring>', description: 'Limit search to resource URLs containing this substring' },
					{ flags: '--pretty', description: 'Render compact context snippets for human output' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus code grep playground --id playground',
					"argus code grep '/window\\\\.playground/' --id playground --url index",
					'argus code grep showLogsByHost --id playground --pretty',
				],
				action: async (pattern, options) => {
					await runCodeGrep(options.id, pattern, options)
				},
			},
			{
				name: 'deminify',
				arguments: [{ flags: '<url>', description: 'Runtime resource URL from `argus code ls`' }],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus code deminify http://127.0.0.1:3333/app.js --id playground',
					'argus code deminify inline://42 --id playground --json',
				],
				action: async (url, options) => {
					await runCodeDeminify(options.id, url, options)
				},
			},
			{
				name: 'edit',
				arguments: [{ flags: '<url>', description: 'Runtime resource URL from `argus code ls`' }],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query' },
					{ flags: '--file <path>', description: 'Read replacement source from a file' },
					{ flags: '--search <pattern>', description: 'Plain string or /regex/flags to find in the existing source' },
					{ flags: '--replace <text>', description: 'Replacement text (required with --search)' },
					{ flags: '--all', description: 'Replace all occurrences (with --search/--replace)' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus code edit http://127.0.0.1:3333/app.js --id playground --search "DEBUG=false" --replace "DEBUG=true"',
					'argus code edit http://127.0.0.1:3333/app.js --id playground --file ./patched.js',
					'cat patched.css | argus code edit inline-css://1 --id playground',
				],
				action: async (url, options) => {
					await runCodeEdit(options.id, url, options)
				},
			},
			{
				name: 'strings',
				arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
				options: [
					{ flags: '--url <substring>', description: 'Limit extraction to resource URLs containing this substring' },
					{ flags: '--min-length <n>', description: 'Minimum string length to include (default: 8)' },
					{ flags: '--limit <n>', description: 'Maximum number of strings to emit (default: 200)' },
					{ flags: '--kind <list>', description: 'Comma-separated kinds: url,key,identifier,message,other' },
					{ flags: '--match <pattern>', description: 'Filter string values by plain text or /regex/flags pattern' },
					{ flags: '--all', description: 'Include low-signal strings instead of only interesting ones' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus code strings playground',
					'argus code strings playground --url app.js --kind url,identifier',
					"argus code strings playground --match '/admin\\/api/'",
					'argus code strings playground --all --min-length 4',
				],
				action: async (id, options) => {
					await runCodeStrings(id, options)
				},
			},
		],
	},
]
