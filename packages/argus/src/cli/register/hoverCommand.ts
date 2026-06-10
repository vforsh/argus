import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDomHover } from '../../commands/domHover.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const hoverCommand: ArgusCommandDefinition = {
	name: 'hover',
	description: 'Hover over element(s) matching a CSS selector',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector to match element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus hover app --selector "#btn"',
		'argus hover app --ref e5',
		'argus hover app --selector ".item" --all',
		'argus hover app --selector "#btn" --json',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomHover(id, options)
	},
}
