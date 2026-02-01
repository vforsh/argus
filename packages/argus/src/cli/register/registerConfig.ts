import type { Command } from 'commander'
import { runConfigInit } from '../../commands/configInit.js'

export function registerConfig(program: Command): void {
	const config = program.command('config').alias('cfg').description('Manage Argus config files')

	config
		.command('init')
		.description('Create an Argus config file')
		.option('--path <file>', 'Path to write the config file (default: .argus/config.json)')
		.option('--force', 'Overwrite existing config file')
		.addHelpText('after', '\nExamples:\n  $ argus config init\n  $ argus config init --path argus.config.json\n')
		.action(async (options) => {
			await runConfigInit(options)
		})
}
