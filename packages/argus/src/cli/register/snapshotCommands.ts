import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runScreenshot } from '../../commands/screenshot.js'
import { runSnapshot } from '../../commands/snapshot.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const snapshotCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'screenshot',
		description: 'Capture a screenshot to disk on the watcher',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--out <file>', description: 'Output file path (absolute or relative to artifacts directory)' },
			{ flags: '--selector <selector>', description: 'Optional CSS selector for element-only capture' },
			{ flags: '--clip <x,y,width,height>', description: 'Viewport-relative rectangle crop in CSS pixels' },
			{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
			{ flags: '--json', description: 'Output JSON for automation' },
		],
		examples: [
			'argus screenshot app',
			'argus screenshot app --out /tmp/screenshot.png',
			'argus screenshot app --selector "body"',
			'argus screenshot app --clip 100,80,640,360',
		],
		action: async (id, options) => {
			if (!resolveTestId(options)) return
			await runScreenshot(id, options)
		},
	},
	{
		name: 'snapshot',
		alias: 'snap',
		aliases: ['ax'],
		description: 'Capture an accessibility tree snapshot of the page',
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options: [
			{ flags: '--selector <css>', description: 'Scope snapshot to a DOM subtree' },
			{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
			{ flags: '--depth <n>', description: 'Max tree depth' },
			{ flags: '-i, --interactive', description: 'Only show interactive elements (buttons, links, inputs, etc.)' },
			{ flags: '--json', description: 'Output JSON for automation' },
		],
		examples: [
			'argus snapshot app',
			'argus snapshot app --interactive',
			'argus snapshot app --selector "form"',
			'argus snapshot app --testid "login-form"',
			'argus snapshot app --depth 3',
			'argus snap app -i',
			'argus ax app',
		],
		action: async (id, options) => {
			if (!resolveTestId(options)) return
			await runSnapshot(id, options)
		},
	},
]
