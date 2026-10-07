import type { ArgusCommandDefinition } from '../defineCommand.js'
import { lazyAction } from '../lazyAction.js'

const runConfigInit = lazyAction(() => import('../../commands/configInit.js').then((mod) => mod.runConfigInit))

export const configCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'config',
		alias: 'cfg',
		description: 'Manage Argus config files',
		subcommands: [
			{
				name: 'init',
				description: 'Create an Argus config file',
				options: [
					{ flags: '--path <file>', description: 'Path to write the config file (default: .argus/config.json)' },
					{ flags: '--force', description: 'Overwrite existing config file' },
				],
				examples: ['argus config init', 'argus config init --path argus.config.json'],
				action: async (options) => {
					await runConfigInit(options)
				},
			},
		],
	},
]
