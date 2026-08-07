type OutputOptions = {
	json?: boolean
}

const ensureTrailingNewline = (value: string): string => (value.endsWith('\n') ? value : `${value}\n`)

/** Route incidental console progress to stderr before JSON-mode plugins are loaded. */
export const configureMachineSafeConsole = (argv: readonly string[]): void => {
	if (!argv.includes('--json') && !argv.includes('--json-full')) {
		return
	}

	const writeConsoleError = console.error.bind(console)
	console.log = writeConsoleError
	console.info = writeConsoleError
	console.debug = writeConsoleError
}

export type Output = {
	json: boolean
	/** Write the command's single machine-readable JSON document. */
	writeJson: (value: unknown) => void
	/** Write one NDJSON record for explicitly streaming commands only. */
	writeJsonLine: (value: unknown) => void
	writeHuman: (text: string) => void
	writeWarn: (text: string) => void
}

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
