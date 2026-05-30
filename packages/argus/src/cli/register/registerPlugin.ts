import type { Command } from 'commander'
import { runPluginList } from '../../commands/pluginList.js'
import { runPluginAdd, runPluginRemove } from '../../commands/pluginConfig.js'

export function registerPlugin(program: Command): void {
	const plugin = program.command('plugin').alias('plugins').description('Manage Argus CLI plugins')

	plugin
		.command('list')
		.alias('ls')
		.description('List plugins discovered for this invocation')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus plugin list\n  $ argus --plugin ./plugins/foo.js plugin list --json\n')
		.action((options) => {
			runPluginList(options)
		})

	plugin
		.command('add <specifier>')
		.description('Add a plugin specifier or alias to the Argus config')
		.option('--path <file>', 'Config file to update (default: discovered config or .argus/config.json)')
		.option('--global', 'Update the per-user Argus config at ARGUS_HOME/config.json')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nExamples:\n  $ argus plugin add gsheets\n  $ argus plugin add --global clogs=~/dev/argus-clogs-plugin/dist/index.js\n  $ argus plugin add gs=@vforsh/argus-plugin-google-sheets\n  $ argus plugin add ./plugins/foo.js\n',
		)
		.action(async (specifier, options) => {
			await runPluginAdd(specifier, options)
		})

	plugin
		.command('remove <specifierOrName>')
		.alias('rm')
		.description('Remove a plugin from the Argus config')
		.option('--path <file>', 'Config file to update (default: discovered config or .argus/config.json)')
		.option('--global', 'Update the per-user Argus config at ARGUS_HOME/config.json')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus plugin remove @vforsh/argus-plugin-google-sheets\n  $ argus plugin remove google-sheets\n')
		.action(async (specifierOrName, options) => {
			await runPluginRemove(specifierOrName, options)
		})
}
