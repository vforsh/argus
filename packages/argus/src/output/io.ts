type OutputOptions = {
	json?: boolean
}

const ensureTrailingNewline = (value: string): string => (value.endsWith('\n') ? value : `${value}\n`)

export type Output = {
	json: boolean
	writeJson: (value: unknown) => void
	writeJsonLine: (value: unknown) => void
	writeHuman: (text: string) => void
	writeWarn: (text: string) => void
}

/** Output helpers that enforce JSON/stdout vs human/stderr rules. */
export const createOutput = (options: OutputOptions): Output => {
	const json = options.json === true

	const writeJsonLine = (value: unknown): void => {
		process.stdout.write(JSON.stringify(value) + '\n')
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
		writeJson: writeJsonLine,
		writeJsonLine,
		writeHuman,
		writeWarn,
	}
}
