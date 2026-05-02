import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import { registerSheetCommands } from './commands.js'

/** Argus plugin that adds Google Sheets read/write commands for an attached browser tab. */
const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'google-sheets',
	version: '0.1.0',
	description: 'Read, search, select, and write the Google Sheets tab attached through Argus.',
	commands: ['sheets', 'gs'],
	register(ctx) {
		registerSheetCommands(ctx)
	},
}

export default plugin
