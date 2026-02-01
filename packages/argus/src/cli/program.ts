import { Command } from 'commander'

export function createProgram(): Command {
	const program = new Command()

	program
		.name('argus')
		.description('Argus CLI for local watcher servers')
		.version('0.1.0')
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
