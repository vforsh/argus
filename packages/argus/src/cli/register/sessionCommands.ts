import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runSession = lazyAction(() => import('../../session/runSession.js').then((mod) => mod.runSession))
const runScript = lazyAction(() => import('../../session/runScript.js').then((mod) => mod.runScript))

export const sessionCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'session',
		description: 'Serve JSONL commands over stdin/stdout against one watcher, in a single process',
		arguments: [{ flags: '[id]', description: 'Watcher id to pin the session to' }],
		options: [
			{ flags: '--request-timeout <duration>', description: 'Per-request watchdog when the request omits one (default: 120s; 0 disables)' },
			{ flags: '--reconnect', description: 'Stay alive when the watcher disappears and re-resolve it by id on the next request' },
			{ ...jsonOption, description: 'Accepted for symmetry; the transport is always JSONL' },
		],
		examples: [
			'argus session app',
			'argus session app --request-timeout 30s',
			'argus session app --reconnect',
			`echo '{"id":1,"cmd":"eval","args":{"expression":"location.href"}}' | argus session app`,
		],
		action: async (id, options) => {
			await runSession(id, options)
		},
	},
	{
		name: 'run',
		description: 'Run argus commands (one per line, from stdin or --file) against one watcher in a single process; stops at the first failure',
		arguments: [{ flags: '[id]', description: 'Watcher id (or @page selector) every line runs against' }],
		options: [
			{ flags: '-f, --file <path>', description: 'Read the script from a file instead of stdin' },
			{ flags: '--keep-going', description: 'Run every step even after a failure' },
			{ ...jsonOption, description: 'Output one JSON document with every step result' },
		],
		examples: [
			`argus run app <<'EOF'\n  click --testid open --settle\n  fill --selector "#q" "hello"\n  keydown Enter --until "document.querySelector('.results')"\n  screenshot --out ./results.png\n  EOF`,
			'argus run app --file ./smoke.argus --json',
		],
		action: async (id, options) => {
			await runScript(id, options)
		},
	},
]
