import type { Command } from 'commander'
import { runDialogAccept, runDialogDismiss, runDialogPrompt, runDialogStatus } from '../../commands/dialog.js'

export function registerDialog(program: Command): void {
	const dialog = program.command('dialog').alias('dialogs').description('Inspect and handle browser dialogs')

	registerSimpleDialogCommand(dialog, {
		name: 'status',
		description: 'Show the currently active browser dialog',
		examples: ['argus dialog status app', 'argus dialog status app --json'],
		run: runDialogStatus,
	})

	registerSimpleDialogCommand(dialog, {
		name: 'accept',
		description: 'Accept the active browser dialog',
		examples: ['argus dialog accept app', 'argus dialog accept app --json'],
		run: runDialogAccept,
	})

	registerSimpleDialogCommand(dialog, {
		name: 'dismiss',
		description: 'Dismiss the active browser dialog',
		examples: ['argus dialog dismiss app', 'argus dialog dismiss app --json'],
		run: runDialogDismiss,
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

type DialogCommandRegistration = {
	name: string
	description: string
	examples: string[]
	run: (id: string | undefined, options: { json?: boolean }) => Promise<void>
}

const registerSimpleDialogCommand = (dialog: Command, command: DialogCommandRegistration): void => {
	dialog
		.command(command.name)
		.description(command.description)
		.argument('[id]', 'Watcher ID')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', formatExamples(command.examples))
		.action(async (id, options) => {
			await command.run(id, options)
		})
}

const formatExamples = (examples: string[]): string => `\nExamples:\n${examples.map((example) => `  $ ${example}`).join('\n')}\n`
