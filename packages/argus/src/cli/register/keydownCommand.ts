import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDomKeydown } from '../../commands/domKeydown.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const keydownCommand: ArgusCommandDefinition = {
	name: 'keydown',
	description: 'Dispatch a keyboard event to the connected page',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--key <name>', description: 'KeyboardEvent.key value (e.g. Enter, a, ArrowUp)' },
		{ flags: '--code <code>', description: 'KeyboardEvent.code value (e.g. KeyG, Digit1)' },
		{ flags: '--selector <css>', description: 'Focus element before dispatching' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--modifiers <list>', description: 'Comma-separated modifiers: shift,ctrl,alt,meta' },
		{ flags: '--shift', description: 'Shortcut for --modifiers shift' },
		{ flags: '--ctrl', description: 'Shortcut for --modifiers ctrl' },
		{ flags: '--alt', description: 'Shortcut for --modifiers alt' },
		{ flags: '--meta', description: 'Shortcut for --modifiers meta' },
		{ flags: '--cmd', description: 'Alias for --meta' },
		{ flags: '--print-event', description: 'Print resolved key/code/modifier event details' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus keydown app --key Enter',
		'argus keydown app --key G',
		'argus keydown app --code KeyG',
		'argus keydown app --key a --selector "#input"',
		'argus keydown app --key a --shift --ctrl',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomKeydown(id, options)
	},
}
