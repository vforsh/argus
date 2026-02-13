import type { Command } from 'commander'
import { runDomFill } from '../../commands/domFill.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export function registerFill(program: Command): void {
	program
		.command('fill')
		.argument('[id]', 'Watcher id to query')
		.argument('[value]', 'Value to fill (or use --value-file / --value-stdin / "-" for stdin)')
		.description('Fill input/textarea/contenteditable elements with a value (triggers framework events)')
		.option('--selector <css>', 'CSS selector for target element(s)')
		.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')
		.option('--name <attr>', 'Shorthand for --selector "[name=<attr>]"')
		.option('--value-file <path>', 'Read value from a file')
		.option('--value-stdin', 'Read value from stdin (also triggered by "-" as value arg)')
		.option('--all', 'Allow multiple matches (default: error if >1 match)')
		.option('--text <string>', 'Filter by textContent (trimmed). Supports /regex/flags syntax')
		.option('--wait <duration>', 'Wait for selector to appear (e.g. 5s, 500ms)')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus fill app --selector "#username" "Bob"\n  $ argus fill app --testid "username" "Bob"\n  $ argus fill app --name "title" "Hello"\n  $ argus fill app --selector "textarea" "New content"\n  $ argus fill app --selector "input[type=text]" --all "reset"\n  $ argus fill app --selector "#desc" --value-file ./description.txt\n  $ echo "hello" | argus fill app --selector "#input" --value-stdin\n  $ argus fill app --selector "#input" - < value.txt\n',
		)
		.action(async (id, value, options) => {
			if (options.testid && options.name) {
				console.error('Cannot use both --testid and --name.')
				process.exitCode = 2
				return
			}
			if (!resolveTestId(options)) return
			await runDomFill(id, value, options)
		})
}
