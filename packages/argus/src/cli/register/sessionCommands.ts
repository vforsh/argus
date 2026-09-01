import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runSession } from '../../session/runSession.js'
import { jsonOption } from './sharedOptions.js'

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
]
