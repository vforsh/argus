import { Command, CommanderError } from 'commander'
import packageJson from '../../package.json' with { type: 'json' }

export type CreateProgramOptions = {
	/**
	 * How the program reacts to Commander's own exits (`--help`, `--version`, parse errors).
	 *
	 * `'process'` — the CLI process owns the exit code and terminates, as a one-shot run must.
	 * `'session'` — the same conditions throw a {@link CommanderError} instead, so the long-lived
	 * `argus session` transport can answer the offending request and keep serving the next one.
	 */
	mode?: 'process' | 'session'
}

export function createProgram(options: CreateProgramOptions = {}): Command {
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
		.exitOverride(options.mode === 'session' ? throwOnExit : exitProcess)

	return program
}

/** Commander requires the callback to throw; returning from it lets `process.exit` run anyway. */
const throwOnExit = (error: CommanderError): never => {
	throw error
}

const exitProcess = (error: CommanderError): never => {
	if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
		process.exit(0)
	}
	console.error(error.message)
	process.exit(2)
}

const collectPluginOption = (value: string, previous: string[]): string[] => [...previous, value]
