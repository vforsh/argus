import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runPluginList } from '../../commands/pluginList.js'
import { runPluginAdd, runPluginRemove } from '../../commands/pluginConfig.js'
import { jsonOption } from './sharedOptions.js'

const configFileOptions = [
	{ flags: '--path <file>', description: 'Config file to update (default: discovered config or .argus/config.json)' },
	{ flags: '--global', description: 'Update the per-user Argus config at ARGUS_HOME/config.json' },
	jsonOption,
] as const

export const pluginCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'plugin',
		alias: 'plugins',
		description: 'Manage Argus CLI plugins',
		subcommands: [
			{
				name: 'list',
				alias: 'ls',
				description: 'List plugins discovered for this invocation',
				options: [jsonOption],
				examples: ['argus plugin list', 'argus --plugin ./plugins/foo.js plugin list --json'],
				action: (options) => {
					runPluginList(options)
				},
			},
			{
				name: 'add <specifier>',
				description: 'Add a plugin specifier or alias to the Argus config',
				options: configFileOptions,
				examples: [
					'argus plugin add gsheets',
					'argus plugin add --global clogs=~/dev/argus-clogs-plugin/dist/index.js',
					'argus plugin add gs=@vforsh/argus-plugin-google-sheets',
					'argus plugin add ./plugins/foo.js',
				],
				action: async (specifier, options) => {
					await runPluginAdd(specifier, options)
				},
			},
			{
				name: 'remove <specifierOrName>',
				alias: 'rm',
				description: 'Remove a plugin from the Argus config',
				options: configFileOptions,
				examples: ['argus plugin remove @vforsh/argus-plugin-google-sheets', 'argus plugin remove google-sheets'],
				action: async (specifierOrName, options) => {
					await runPluginRemove(specifierOrName, options)
				},
			},
		],
	},
]
