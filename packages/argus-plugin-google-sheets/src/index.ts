import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import { createRequire } from 'node:module'
import { registerSheetCommands } from './commands.js'

const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version

/** Argus plugin that adds Google Sheets read/write commands for an attached browser tab. */
const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'google-sheets',
	version: packageVersion,
	description: 'Read, search, select, and write the Google Sheets tab attached through Argus.',
	commands: ['sheets', 'gs'],
	register(ctx) {
		registerSheetCommands(ctx)
	},
}

export default plugin
