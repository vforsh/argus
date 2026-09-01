type OutputOptions = {
	json?: boolean
}

import type { ArgusOutput } from '@vforsh/argus-plugin-api'
const ensureTrailingNewline = (value: string): string => (value.endsWith('\n') ? value : `${value}\n`)

/** Route incidental console progress to stderr before JSON-mode plugins are loaded. */
export const configureMachineSafeConsole = (argv: readonly string[]): void => {
	if (argv.includes('--json') || argv.includes('--json-full') || isMachineOnlyCommand(argv)) {
		routeConsoleToStderr()
	}
}

/**
 * Commands whose stdout is machine-only regardless of flags.
 *
 * `argus session` writes JSONL from its first byte, and plugins load — and log — before its
 * action ever runs, so the decision cannot wait for the flag scan the rest of this uses.
 */
const MACHINE_ONLY_COMMANDS = new Set(['session'])

const isMachineOnlyCommand = (argv: readonly string[]): boolean => {
	const command = argv.find((token, index) => !token.startsWith('-') && argv[index - 1] !== '--plugin')
	return command != null && MACHINE_ONLY_COMMANDS.has(command)
}

/**
 * Send `console.log`/`info`/`debug` to stderr for the rest of the process.
 *
 * Callers that always speak machine output — `argus session`, whose stdout carries nothing but
 * JSONL — need this unconditionally rather than keyed off a flag in argv.
 */
export const routeConsoleToStderr = (): void => {
	const writeConsoleError = console.error.bind(console)
	console.log = writeConsoleError
	console.info = writeConsoleError
	console.debug = writeConsoleError
}

/**
 * Output helpers that enforce JSON/stdout vs human/stderr rules.
 *
 * Declared by `@vforsh/argus-plugin-api`, which is the published contract: the CLI hands
 * this exact object to plugins, so re-declaring it here would let the two drift silently.
 */
export type Output = ArgusOutput

/** Output helpers that enforce JSON/stdout vs human/stderr rules. */
export const createOutput = (options: OutputOptions): Output => {
	const json = options.json === true
	let wroteJsonDocument = false

	const writeJsonLine = (value: unknown): void => {
		process.stdout.write(JSON.stringify(value) + '\n')
	}

	const writeJson = (value: unknown): void => {
		if (wroteJsonDocument) {
			throw new Error('Attempted to write more than one JSON document to stdout')
		}
		wroteJsonDocument = true
		writeJsonLine(value)
	}

	const writeHuman = (text: string): void => {
		const line = ensureTrailingNewline(text)
		if (json) {
			process.stderr.write(line)
		} else {
			process.stdout.write(line)
		}
	}

	const writeWarn = (text: string): void => {
		process.stderr.write(ensureTrailingNewline(text))
	}

	return {
		json,
		writeJson,
		writeJsonLine,
		writeHuman,
		writeWarn,
	}
}
