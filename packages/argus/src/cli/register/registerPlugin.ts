import type { Command } from 'commander'
import { runPluginList } from '../../commands/pluginList.js'

export function registerPlugin(program: Command): void {
	const plugin = program.command('plugin').alias('plugins').description('Inspect Argus CLI plugins')

	plugin
		.command('list')
		.alias('ls')
		.description('List plugins discovered for this invocation')
		.option('--json', 'Output JSON for automation')
		.addHelpText('after', '\nExamples:\n  $ argus plugin list\n  $ argus --plugin ./plugins/foo.js plugin list --json\n')
		.action((options) => {
			runPluginList(options)
		})
}
