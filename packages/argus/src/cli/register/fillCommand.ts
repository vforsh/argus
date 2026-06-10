import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDomFill } from '../../commands/domFill.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

export const fillCommand: ArgusCommandDefinition = {
	name: 'fill',
	description: 'Fill input/textarea/contenteditable elements with a value',
	arguments: [
		{ flags: '[id]', description: 'Watcher id to query' },
		{ flags: '[value]', description: 'Value to fill (or use --value-file / --value-stdin / "-" for stdin)' },
	],
	options: [
		{ flags: '--selector <css>', description: 'CSS selector for target element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
		{ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' },
		{ flags: '--name <attr>', description: 'Shorthand for --selector "[name=<attr>]"' },
		{ flags: '--value-file <path>', description: 'Read value from a file' },
		{ flags: '--value-stdin', description: 'Read value from stdin (also triggered by "-" as value arg)' },
		{ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' },
		{ flags: '--text <string>', description: 'Filter by textContent (trimmed). Supports /regex/flags syntax' },
		{ flags: '--wait <duration>', description: 'Wait for selector to appear (e.g. 5s, 500ms)' },
		{ flags: '--json', description: 'Output JSON for automation' },
	],
	examples: [
		'argus fill app --selector "#username" "Bob"',
		'argus fill app --testid "username" "Bob"',
		'argus fill app --ref e7 "Bob"',
		'argus fill app --name "title" "Hello"',
		'argus fill app --selector "textarea" "New content"',
		'argus fill app --selector "input[type=text]" --all "reset"',
		'argus fill app --selector "#desc" --value-file ./description.txt',
		'echo "hello" | argus fill app --selector "#input" --value-stdin',
		'argus fill app --selector "#input" - < value.txt',
	],
	action: async (id, value, options) => {
		if (options.name && (options.testid || options.ref)) {
			console.error('Cannot use --name with --testid or --ref.')
			process.exitCode = 2
			return
		}
		if (!resolveTestId(options)) return
		await runDomFill(id, value, options)
	},
}
