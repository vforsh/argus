import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDomKeydown } from '../../commands/domKeydown.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const keydownCommand: ArgusCommandDefinition = {
	name: 'keydown',
	description: 'Dispatch a keyboard event to the connected page',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--key <name>', description: 'Key name (e.g. Enter, a, ArrowUp)', required: true },
		{ flags: '--selector <css>', description: 'Focus element before dispatching' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--modifiers <list>', description: 'Comma-separated modifiers: shift,ctrl,alt,meta' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: ['argus keydown app --key Enter', 'argus keydown app --key a --selector "#input"', 'argus keydown app --key a --modifiers shift,ctrl'],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomKeydown(id, options)
	},
}
