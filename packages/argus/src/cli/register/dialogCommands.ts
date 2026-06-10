import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runDialogAccept, runDialogDismiss, runDialogPrompt, runDialogStatus } from '../../commands/dialog.js'

const simpleDialogCommand = (input: {
	name: string
	description: string
	examples: string[]
	run: (id: string | undefined, options: { json?: boolean }) => Promise<void>
}): ArgusCommandDefinition => ({
	name: input.name,
	description: input.description,
	arguments: [{ flags: '[id]', description: 'Watcher ID' }],
	options: [{ flags: '--json', description: 'Output JSON for automation' }],
	examples: input.examples,
	action: async (id, options) => {
		await input.run(id, options)
	},
})

export const dialogCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'dialog',
		alias: 'dialogs',
		description: 'Inspect and handle browser dialogs',
		subcommands: [
			simpleDialogCommand({
				name: 'status',
				description: 'Show the currently active browser dialog',
				examples: ['argus dialog status app', 'argus dialog status app --json'],
				run: runDialogStatus,
			}),
			simpleDialogCommand({
				name: 'accept',
				description: 'Accept the active browser dialog',
				examples: ['argus dialog accept app', 'argus dialog accept app --json'],
				run: runDialogAccept,
			}),
			simpleDialogCommand({
				name: 'dismiss',
				description: 'Dismiss the active browser dialog',
				examples: ['argus dialog dismiss app', 'argus dialog dismiss app --json'],
				run: runDialogDismiss,
			}),
			{
				name: 'prompt',
				description: 'Accept the active prompt dialog with custom text',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [
					{ flags: '--text <text>', description: 'Prompt response text', required: true },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: ['argus dialog prompt app --text "hello"', 'argus dialog prompt app --text "hello" --json'],
				action: async (id, options) => {
					await runDialogPrompt(id, options.text, options)
				},
			},
		],
	},
]
