import type { Command } from 'commander'
import { runLocateLabel, runLocateRole, runLocateText } from '../../commands/locate.js'

export function registerLocate(program: Command): void {
	const locate = program.command('locate').description('Find semantic elements and return stable refs for later actions')

	locate
		.command('role')
		.argument('[id]', 'Watcher id to query')
		.argument('<role>', 'Accessibility role to match (e.g. button, textbox, link)')
		.description('Locate elements by accessibility role and optional accessible name')
		.option('--name <text>', 'Match the element accessible name')
		.option('--exact', 'Require an exact normalized name match')
		.option('--all', 'Return all matches (default: error if >1 match)')
		.option('--action <action>', 'Immediately run one action: click, fill, focus, hover')
		.option('--value <text>', 'Fill value when used with --action fill')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus locate role app button --name "Submit"\n  $ argus locate role app textbox --name "Email" --action fill --value "me@example.com"\n  $ argus locate role app link --all\n',
		)
		.action(async (id, role, options) => {
			await runLocateRole(id, role, options)
		})

	locate
		.command('text')
		.argument('[id]', 'Watcher id to query')
		.argument('<text>', 'Visible/accessible text to match')
		.description('Locate elements by visible/accessible text')
		.option('--exact', 'Require an exact normalized text match')
		.option('--all', 'Return all matches (default: error if >1 match)')
		.option('--action <action>', 'Immediately run one action: click, fill, focus, hover')
		.option('--value <text>', 'Fill value when used with --action fill')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus locate text app "Accept"\n  $ argus locate text app "Continue" --action click\n  $ argus locate text app "Home" --all\n',
		)
		.action(async (id, text, options) => {
			await runLocateText(id, text, options)
		})

	locate
		.command('label')
		.argument('[id]', 'Watcher id to query')
		.argument('<label>', 'Form label / accessible name to match')
		.description('Locate form controls by their label or accessible name')
		.option('--exact', 'Require an exact normalized label match')
		.option('--all', 'Return all matches (default: error if >1 match)')
		.option('--action <action>', 'Immediately run one action: click, fill, focus, hover')
		.option('--value <text>', 'Fill value when used with --action fill')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus locate label app "Email"\n  $ argus locate label app "Email" --action fill --value "me@example.com"\n',
		)
		.action(async (id, label, options) => {
			await runLocateLabel(id, label, options)
		})
}
