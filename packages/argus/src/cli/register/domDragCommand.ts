import type { ArgusCommandDefinition } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { lazyAction } from '../lazyAction.js'

const runDomDrag = lazyAction(() => import('../../commands/domDrag.js').then((mod) => mod.runDomDrag))

/** CLI definition for the top-level `argus drag` command. */
export const domDragCommandDefinition: ArgusCommandDefinition = {
	name: 'drag',
	description: 'Drag from coordinates or an element using real browser mouse input',
	arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector to drag from' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' },
		{ flags: '--pos <x,y>', description: 'Viewport start coordinates or offset from element top-left' },
		{ flags: '--to <x,y>', description: 'Absolute viewport destination' },
		{ flags: '--by <dx,dy>', description: 'Destination delta from the resolved start point' },
		{ flags: '--button <type>', description: 'Mouse button: left, middle, right (default: left)' },
		{ flags: '--duration <duration>', description: 'Total drag duration (default: 250ms)' },
		{ flags: '--steps <n>', description: 'Number of mousemove steps (default: 12)' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--wait <duration>', description: 'Wait for selector to appear (e.g. 5s, 500ms)' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus drag app --pos 200,300 --to 500,300',
		'argus drag app --selector "#piece" --by 120,0',
		'argus drag app --selector "canvas" --pos 320,240 --by 80,-30',
		'argus drag app --ref e7 --by 0,-180 --duration 600ms --steps 30',
	],
	action: async (id, options) => {
		if (!resolveTestId(options)) return
		await runDomDrag(id, options)
	},
}
