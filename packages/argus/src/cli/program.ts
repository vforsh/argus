import { Command } from 'commander'
import packageJson from '../../package.json' with { type: 'json' }

export function createProgram(): Command {
	const program = new Command()

	program
		.name('argus')
		.description('Argus CLI for local watcher servers')
		.version(packageJson.version)
		.configureOutput({
			outputError: (str, write) => write(str),
		})
		.showSuggestionAfterError(true)
		.exitOverride((error) => {
			if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
				process.exit(0)
			}
			console.error(error.message)
			process.exit(2)
		})

	return program
}
