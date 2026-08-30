import { Command } from 'commander'
import packageJson from '../../package.json' with { type: 'json' }

export function createProgram(): Command {
	const program = new Command()

	program
		.name('argus')
		.description('Argus CLI for local watcher servers')
		.version(packageJson.version)
		.option('--plugin <specifier>', 'Load an extra CLI plugin for this invocation', collectPluginOption, [])
		.configureOutput({
			outputError: (str, write) => write(str),
		})
		.showSuggestionAfterError(true)
		// Options belong to the command they follow. Several parents declare the same flag
		// name as a subcommand (`net --method` is a repeatable filter, `net mock add
		// --method` is a scalar match), and without this the parent claims the value.
		.enablePositionalOptions()
		.exitOverride((error) => {
			if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
				process.exit(0)
			}
			console.error(error.message)
			process.exit(2)
		})

	return program
}

const collectPluginOption = (value: string, previous: string[]): string[] => [...previous, value]
