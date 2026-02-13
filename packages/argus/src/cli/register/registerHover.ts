import type { Command } from 'commander'
import { runDomHover } from '../../commands/domHover.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerHover(program: Command): void {
	program
		.command('hover')
		.argument('[id]', 'Watcher id to query')
		.description('Hover over element(s) matching a CSS selector')
		.option('--selector <css>', 'CSS selector to match element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus hover app --selector "#btn"\n  $ argus hover app --selector ".item" --all\n  $ argus hover app --selector "#btn" --json\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomHover(id, options)
		})
}
