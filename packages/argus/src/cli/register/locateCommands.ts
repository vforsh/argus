import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runLocateLabel, runLocateRole, runLocateText } from '../../commands/locate.js'

const sharedLocateOptions = [
	{ flags: '--exact', description: 'Require an exact normalized text match' },
	{ flags: '--all', description: 'Return all matches (default: error if >1 match)' },
	{ flags: '--action <action>', description: 'Immediately run one action: click, fill, focus, hover' },
	{ flags: '--value <text>', description: 'Fill value when used with --action fill' },
	{ flags: '--json', description: 'Output JSON for automation' },
] as const

export const locateCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'locate',
		description: 'Find semantic elements and return stable refs for later actions',
		subcommands: [
			{
				name: 'role',
				description: 'Locate elements by accessibility role and optional accessible name',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query' },
					{ flags: '<role>', description: 'Accessibility role to match (e.g. button, textbox, link)' },
				],
				options: [{ flags: '--name <text>', description: 'Match the element accessible name' }, ...sharedLocateOptions],
				examples: [
					'argus locate role app button --name "Submit"',
					'argus locate role app textbox --name "Email" --action fill --value "me@example.com"',
					'argus locate role app link --all',
				],
				action: async (id, role, options) => {
					await runLocateRole(id, role, options)
				},
			},
			{
				name: 'text',
				description: 'Locate elements by visible/accessible text',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query' },
					{ flags: '<text>', description: 'Visible/accessible text to match' },
				],
				options: sharedLocateOptions,
				examples: ['argus locate text app "Accept"', 'argus locate text app "Continue" --action click', 'argus locate text app "Home" --all'],
				action: async (id, text, options) => {
					await runLocateText(id, text, options)
				},
			},
			{
				name: 'label',
				description: 'Locate form controls by their label or accessible name',
				arguments: [
					{ flags: '[id]', description: 'Watcher id to query' },
					{ flags: '<label>', description: 'Form label / accessible name to match' },
				],
				options: sharedLocateOptions,
				examples: ['argus locate label app "Email"', 'argus locate label app "Email" --action fill --value "me@example.com"'],
				action: async (id, label, options) => {
					await runLocateLabel(id, label, options)
				},
			},
		],
	},
]
