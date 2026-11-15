import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runSession = lazyAction(() => import('../../session/runSession.js').then((mod) => mod.runSession))
const collectLine = (value: string, previous: string[] = []): string[] => [...previous, value]

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
		description: 'Run several argus commands against one watcher in one process (-e per command, stdin, or --file); stops at the first failure',
		arguments: [{ flags: '[id]', description: 'Watcher id (or @page selector) every line runs against' }],
		options: [
			{ flags: '-e, --expr <line>', description: 'One command, as typed after `argus` (repeatable; runs before --file)', parser: collectLine, defaultValue: [] },
			{ flags: '-f, --file <path>', description: 'Read the script from a file (stdin is read only without -e/--file)' },
			{ flags: '--keep-going', description: 'Run every step even after a failure (use it for diagnostics: one report covers every step)' },
			{ ...jsonOption, description: 'Output one JSON document: { ok, steps: [{ step, cmd, line, ok, result | error }] }' },
		],
		examples: [
			`argus run app -e 'click --testid play --settle' -e 'probe score=appctl.score' -e 'screenshot --out a.png'`,
			`argus run app -e 'reload' -e 'wait --global appctl.ready' -e 'probe url=location.href' -e 'screenshot --out after.png' --json`,
			`argus run app --keep-going -e 'logs --levels error --since 1m' -e 'net --failed-only' -e 'probe ready=!!window.app'`,
			`argus run app <<'EOF'\n  click --testid open --settle\n  fill --selector "#q" "hello"\n  keydown Enter --until "document.querySelector('.results')"\n  screenshot --out ./results.png\n  EOF`,
			'argus run app --file ./smoke.argus --json',
		],
		action: async (id, options) => {
			await runScript(id, options)
		},
	},
]
