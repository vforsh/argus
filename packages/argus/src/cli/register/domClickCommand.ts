import type { ArgusCommandDefinition } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { lazyAction } from '../lazyAction.js'

const runDomClick = lazyAction(() => import('../../commands/domClick.js').then((mod) => mod.runDomClick))

/** CLI definition for the top-level `argus click` command. */
export const domClickCommandDefinition: ArgusCommandDefinition = {
	name: 'click',
	description: 'Click at coordinates or on element(s) matching a CSS selector',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector to match element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' },
		{ flags: '--pos <x,y>', description: 'Viewport coordinates or offset from element top-left' },
		{ flags: '--button <type>', description: 'Mouse button: left, middle, right (default: left)' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--wait <duration>', description: 'Wait for selector to appear (e.g. 5s, 500ms)' },
		{ flags: '--wait-nav [mode]', description: 'Wait for a top-frame navigation after the click: load (default), domcontentloaded, none' },
		{ flags: '--nav-timeout <duration>', description: 'Budget for --wait-nav (e.g. 10s). Default: 10s' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus click app --pos 100,200',
		'argus click app --selector "#btn"',
		'argus click app --testid "submit-btn"',
		'argus click app --ref e5',
		'argus click app --selector "#btn" --pos 10,5',
		'argus click app --selector ".item" --all',
		'argus click app --selector "#btn" --button right',
		'argus click app --pos 100,200 --button middle',
		'argus click app --selector "a.next" --wait-nav',
		'argus click app --selector "a.next" --wait-nav domcontentloaded --nav-timeout 5s',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomClick(id, options)
	},
}
