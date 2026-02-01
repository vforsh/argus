import type { Command } from 'commander'
import { runScreenshot } from '../../commands/screenshot.js'
import { runSnapshot } from '../../commands/snapshot.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerSnapshot(program: Command): void {
	program
		.command('screenshot')
		.argument('[id]', 'Watcher id to query')
		.description('Capture a screenshot to disk on the watcher')
		.option('--out <file>', 'Output file path (absolute or relative to artifacts directory)')
		.option('--selector <selector>', 'Optional CSS selector for element-only capture')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus screenshot app\n  $ argus screenshot app --out /tmp/screenshot.png\n  $ argus screenshot app --selector "body"\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runScreenshot(id, options)
		})

	program
		.command('snapshot')
		.alias('snap')
		.alias('ax')
		.argument('[id]', 'Watcher id to query')
		.description('Capture an accessibility tree snapshot of the page')
		.option('--selector <css>', 'Scope snapshot to a DOM subtree')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--depth <n>', 'Max tree depth')
		.option('-i, --interactive', 'Only show interactive elements (buttons, links, inputs, etc.)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus snapshot app\n  $ argus snapshot app --interactive\n  $ argus snapshot app --selector "form"\n  $ argus snapshot app --testid "login-form"\n  $ argus snapshot app --depth 3\n  $ argus snap app -i\n  $ argus ax app\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runSnapshot(id, options)
		})
}
