import type { Command } from 'commander'
import { runDomScrollTo } from '../../commands/domScrollTo.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerScrollTo(program: Command): void {
	program
		.command('scroll-to')
		.argument('[id]', 'Watcher id to query')
		.description('Scroll the viewport or elements into view / to a position')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--to <x,y>', 'Scroll to absolute position (viewport or element)')
		.option('--by <x,y>', 'Scroll by delta (viewport or element)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus scroll-to app --selector "#footer"\n  $ argus scroll-to app --testid "footer"\n  $ argus scroll-to app --to 0,1000\n  $ argus scroll-to app --by 0,500\n  $ argus scroll-to app --selector ".panel" --to 0,1000\n  $ argus scroll-to app --selector ".panel" --by 0,500\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomScrollTo(id, options)
		})
}
