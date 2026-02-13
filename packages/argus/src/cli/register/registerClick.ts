import type { Command } from 'commander'
import { runDomClick } from '../../commands/domClick.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerClick(program: Command): void {
	program
		.command('click')
		.argument('[id]', 'Watcher id to query')
		.description('Click at coordinates or on element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--pos <x,y>', 'Viewport coordinates or offset from element top-left')
		.option('--button <type>', 'Mouse button: left, middle, right (default: left)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--wait <duration>', 'Wait for selector to appear (e.g. 5s, 500ms)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus click app --pos 100,200\n  $ argus click app --selector "#btn"\n  $ argus click app --testid "submit-btn"\n  $ argus click app --selector "#btn" --pos 10,5\n  $ argus click app --selector ".item" --all\n  $ argus click app --selector "#btn" --button right\n  $ argus click app --pos 100,200 --button middle\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomClick(id, options)
		})
}
