import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDomScrollTo } from '../../commands/domScrollTo.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const scrollToCommand: ArgusCommandDefinition = {
	name: 'scroll-to',
	description: 'Scroll the viewport or elements into view / to a position',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector to match element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--to <x,y>', description: 'Scroll to absolute position (viewport or element)' },
		{ flags: '--by <x,y>', description: 'Scroll by delta (viewport or element)' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus scroll-to app --selector "#footer"',
		'argus scroll-to app --testid "footer"',
		'argus scroll-to app --to 0,1000',
		'argus scroll-to app --by 0,500',
		'argus scroll-to app --selector ".panel" --to 0,1000',
		'argus scroll-to app --selector ".panel" --by 0,500',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomScrollTo(id, options)
	},
}
