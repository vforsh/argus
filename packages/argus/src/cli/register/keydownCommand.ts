import type { ArgusCommandDefinition } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'
import { actionOptions, jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'
import { usageError } from '../validation.js'

const runDomKeydown = lazyAction(() => import('../../commands/domKeydown.js').then((mod) => mod.runDomKeydown))

export const keydownCommand: ArgusCommandDefinition = {
	name: 'keydown',
	description: 'Dispatch a keyboard event to the connected page',
	arguments: [
		{ flags: '[id]', description: 'Watcher id to query' },
		{ flags: '[key]', description: 'KeyboardEvent.key value; shorthand for --key' },
	],
	options: [
		{ flags: '--key <name>', description: 'KeyboardEvent.key value (e.g. Enter, a, ArrowUp)' },
		{ flags: '--code <code>', description: 'KeyboardEvent.code value (e.g. KeyG, Digit1, Backquote)' },
		{ flags: '--selector <css>', description: 'Focus element before dispatching' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--modifiers <list>', description: 'Comma-separated modifiers: shift,ctrl,alt,meta' },
		{ flags: '--shift', description: 'Shortcut for --modifiers shift' },
		{ flags: '--ctrl', description: 'Shortcut for --modifiers ctrl' },
		{ flags: '--alt', description: 'Shortcut for --modifiers alt' },
		{ flags: '--meta', description: 'Shortcut for --modifiers meta' },
		{ flags: '--cmd', description: 'Alias for --meta' },
		{ flags: '--print-event', description: 'Print resolved key/code/modifier event details' },
		{ flags: '--wait-nav [mode]', description: 'Wait for a top-frame navigation after the key: load (default), domcontentloaded, none' },
		{ flags: '--nav-timeout <duration>', description: 'Budget for --wait-nav (e.g. 10s). Default: 10s' },
		...actionOptions,
		jsonOption,
	],
	examples: [
		'argus keydown app --key Enter',
		'argus keydown app Escape',
		'argus keydown app --key G',
		'argus keydown app --code KeyG',
		'argus keydown app --code Backquote --shift',
		'argus keydown app --key a --selector "#input"',
		'argus keydown app --key a --shift --ctrl',
		'argus keydown app --key Enter --selector "#search" --wait-nav',
	],
	action: async (id, key, options) => {
		if (key != null) {
			if (options.key != null && options.key !== key) {
				usageError(options, `Conflicting keys: positional "${key}" and --key "${options.key}".`)
				return
			}
			options.key = key
		}
		if (!resolveTestId(options)) return
		await runDomKeydown(id, options)
	},
}
