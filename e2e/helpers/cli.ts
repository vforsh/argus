import { BIN_PATH } from './paths.js'
import { runCommand, runCommandWithExit, type CommandOptions, type CommandResult, type CommandResultWithExit } from './process.js'

/** `process.env` with Argus state isolated under `home`; `extra` adds e.g. `ARGUS_REGISTRY_PATH` or `ARGUS_PLUGINS`. */
export const argusEnv = (home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, ARGUS_HOME: home, ...extra })

export type CliOptions = {
	env?: NodeJS.ProcessEnv
	cwd?: string
	/** Interpreter for the entry point. Suites pin one deliberately; Node mirrors production. */
	runtime?: 'bun' | 'node'
	bin?: string
}

export type Cli = {
	/** Run to completion; rejects with stdout and stderr on a non-zero exit. */
	run: (args: string[], options?: CommandOptions) => Promise<CommandResult>
	/** Run to completion and report the exit code instead of rejecting. */
	exec: (args: string[], options?: CommandOptions) => Promise<CommandResultWithExit>
	/** `run`, then parse stdout as a single JSON document. */
	json: <T = unknown>(args: string[], options?: CommandOptions) => Promise<T>
}

/** Bind an Argus entry point, interpreter, env and cwd once per suite. Per-call options (e.g. `input`) win. */
export const createCli = ({ env, cwd, runtime = 'bun', bin = BIN_PATH }: CliOptions = {}): Cli => {
	const withDefaults = (options?: CommandOptions): CommandOptions => ({ env, cwd, ...options })
	const run: Cli['run'] = (args, options) => runCommand(runtime, [bin, ...args], withDefaults(options))
	return {
		run,
		exec: (args, options) => runCommandWithExit(runtime, [bin, ...args], withDefaults(options)),
		json: async <T>(args: string[], options?: CommandOptions) => parseJson<T>((await run(args, options)).stdout, `argus ${args.join(' ')}`),
	}
}

/** Parse CLI stdout, naming the command and quoting the output when it is not JSON. */
export const parseJson = <T>(stdout: string, context: string): T => {
	try {
		return JSON.parse(stdout) as T
	} catch {
		throw new Error(`${context}: stdout is not JSON:\n${stdout}`)
	}
}
