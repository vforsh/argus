import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'
import { usageError } from '../validation.js'

const runCodeDeminify = lazyAction(() => import('../../commands/code.js').then((mod) => mod.runCodeDeminify))
const runCodeGrep = lazyAction(() => import('../../commands/code.js').then((mod) => mod.runCodeGrep))
const runCodeList = lazyAction(() => import('../../commands/code.js').then((mod) => mod.runCodeList))
const runCodeRead = lazyAction(() => import('../../commands/code.js').then((mod) => mod.runCodeRead))
const runCodeStrings = lazyAction(() => import('../../commands/code.js').then((mod) => mod.runCodeStrings))
const runCodeEdit = lazyAction(() => import('../../commands/codeEdit.js').then((mod) => mod.runCodeEdit))

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
					jsonOption,
				],
				examples: ['argus code ls playground', 'argus code ls playground --pattern index'],
				action: async (id, options) => {
					await runCodeList(id, options)
				},
			},
			{
				name: 'read',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query (or --id)' },
					{ flags: '[url]', description: 'Runtime resource URL from `argus code ls` (required)' },
				],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query (same as the positional id)' },
					{ flags: '--offset <n>', description: 'Zero-based line offset' },
					{ flags: '--limit <n>', description: 'Max number of lines to return' },
					jsonOption,
				],
				examples: [
					'argus code read playground http://127.0.0.1:3333/',
					'argus code read playground inline://123 --offset 50 --limit 80',
				],
				action: async (first, second, options) => {
					const target = resolveWatcherAndTarget(first, second, options, 'read', 'url')
					if (!target) return
					await runCodeRead(target.id, target.value, options)
				},
			},
			{
				name: 'grep',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query (or --id)' },
					{ flags: '[pattern]', description: 'Plain string or /regex/flags pattern (required)' },
				],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query (same as the positional id)' },
					{ flags: '--url <substring>', description: 'Limit search to resource URLs containing this substring' },
					{ flags: '--pretty', description: 'Render compact context snippets for human output' },
					{
						flags: '--around <chars>',
						description: 'Report each match as an excerpt with this many characters of context per side (default: 200, for lines over 2000 chars only)',
					},
					{ flags: '--max-per-line <n>', description: 'Most matches reported per excerpted line (default: 10)' },
					jsonOption,
				],
				examples: [
					'argus code grep playground playground',
					'argus code grep app fetchBoard --url bundle --around 80',
					"argus code grep playground '/window\\\\.playground/' --url index",
					'argus code grep playground showLogsByHost --pretty',
				],
				action: async (first, second, options) => {
					const target = resolveWatcherAndTarget(first, second, options, 'grep', 'pattern')
					if (!target) return
					await runCodeGrep(target.id, target.value, options)
				},
			},
			{
				name: 'deminify',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query (or --id)' },
					{ flags: '[url]', description: 'Runtime resource URL from `argus code ls` (required)' },
				],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query (same as the positional id)' },
					jsonOption,
				],
				examples: [
					'argus code deminify playground http://127.0.0.1:3333/app.js',
					'argus code deminify playground inline://42 --json',
				],
				action: async (first, second, options) => {
					const target = resolveWatcherAndTarget(first, second, options, 'deminify', 'url')
					if (!target) return
					await runCodeDeminify(target.id, target.value, options)
				},
			},
			{
				name: 'edit',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query (or --id)' },
					{ flags: '[url]', description: 'Runtime resource URL from `argus code ls` (required)' },
				],
				options: [
					{ flags: '--id <watcherId>', description: 'Watcher id to query (same as the positional id)' },
					{ flags: '--file <path>', description: 'Read replacement source from a file' },
					{ flags: '--search <pattern>', description: 'Plain string or /regex/flags to find in the existing source' },
					{ flags: '--replace <text>', description: 'Replacement text (required with --search)' },
					{ flags: '--all', description: 'Replace all occurrences (with --search/--replace)' },
					jsonOption,
				],
				examples: [
					'argus code edit playground http://127.0.0.1:3333/app.js --search "DEBUG=false" --replace "DEBUG=true"',
					'argus code edit playground http://127.0.0.1:3333/app.js --file ./patched.js',
					'cat patched.css | argus code edit playground inline-css://1',
				],
				action: async (first, second, options) => {
					const target = resolveWatcherAndTarget(first, second, options, 'edit', 'url')
					if (!target) return
					await runCodeEdit(target.id, target.value, options)
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
					jsonOption,
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

/**
 * Read `[id] <pattern|url>` for the `code` subcommands that also take a resource argument.
 *
 * They used to take the watcher only as `--id`, so `argus code grep app foo` — the shape every
 * other command has — failed with "too many arguments". Commander cannot express an optional
 * argument before a required one (a lone value would bind to `[id]` and then fail as a missing
 * pattern), so both are declared optional and a lone value is the pattern/url here; `--id` stays
 * for old scripts. The leading `[id]` also makes `argus session` inject its pinned watcher.
 */
const resolveWatcherAndTarget = (
	first: string | undefined,
	second: string | undefined,
	options: { json?: boolean; id?: string },
	subcommand: string,
	targetName: string,
): { id: string | undefined; value: string } | null => {
	const [positionalId, value] = second === undefined ? [undefined, first] : [first, second]
	if (value === undefined) {
		usageError(options, `Missing <${targetName}>. Usage: argus code ${subcommand} [id] <${targetName}>.`)
		return null
	}
	if (positionalId !== undefined && options.id !== undefined && positionalId !== options.id) {
		usageError(options, `Watcher id given twice: positional "${positionalId}" and --id "${options.id}". Pass one.`)
		return null
	}
	return { id: positionalId ?? options.id, value }
}
