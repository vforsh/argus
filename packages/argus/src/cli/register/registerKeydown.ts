import type { Command } from 'commander'
import { runDomKeydown } from '../../commands/domKeydown.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerKeydown(program: Command): void {
	program
		.command('keydown')
		.argument('[id]', 'Watcher id to query')
		.description('Dispatch a keyboard event to the connected page')
		.requiredOption('--key <name>', 'Key name (e.g. Enter, a, ArrowUp)')
		.option('--selector <css>', 'Focus element before dispatching')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--modifiers <list>', 'Comma-separated modifiers: shift,ctrl,alt,meta')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus keydown app --key Enter\n  $ argus keydown app --key a --selector "#input"\n  $ argus keydown app --key a --modifiers shift,ctrl\n',
		)
		.action(async (id, options) => {
			if (!resolveTestId(options)) return
			await runDomKeydown(id, options)
		})
}
