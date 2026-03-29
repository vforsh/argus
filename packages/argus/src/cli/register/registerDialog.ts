import type { Command } from 'commander'
import { runDialogAccept, runDialogDismiss, runDialogPrompt, runDialogStatus } from '../../commands/dialog.js'

export function registerDialog(program: Command): void {
	const dialog = program.command('dialog').alias('dialogs').description('Inspect and handle browser dialogs')

	dialog
		.command('status')
		.description('Show the currently active browser dialog')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus dialog status app\n  $ argus dialog status app --json\n')
		.action(async (id, options) => {
			await runDialogStatus(id, options)
		})

	dialog
		.command('accept')
		.description('Accept the active browser dialog')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus dialog accept app\n  $ argus dialog accept app --json\n')
		.action(async (id, options) => {
			await runDialogAccept(id, options)
		})

	dialog
		.command('dismiss')
		.description('Dismiss the active browser dialog')
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus dialog dismiss app\n  $ argus dialog dismiss app --json\n')
		.action(async (id, options) => {
			await runDialogDismiss(id, options)
		})

	dialog
		.command('prompt')
		.description('Accept the active prompt dialog with custom text')
		.argument('[id]', 'Watcher ID')
		.requiredOption('--text <text>', 'Prompt response text')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus dialog prompt app --text "hello"\n  $ argus dialog prompt app --text "hello" --json\n')
		.action(async (id, options) => {
			await runDialogPrompt(id, options.text, options)
		})
}
