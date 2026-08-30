import { createOutput } from '../output/io.js'

/**
 * Report a bad flag combination and set the usage exit code.
 *
 * Register-layer validators ran before a command built its `Output`, so they wrote straight to
 * `console.error`. That happened to land on stderr like `writeWarn` does, but it bypassed the one
 * contract that decides where CLI text goes — and left the `--json` flag they already hold unused.
 *
 * @returns `false`, so a validator can `return usageError(options, '…')`.
 */
export const usageError = (options: { json?: boolean }, message: string): false => {
	createOutput(options).writeWarn(message)
	process.exitCode = 2
	return false
}

export const collectMatch = (value: string, previous: string[]): string[] => [...previous, value]
export const collectParam = (value: string, previous: string[]): string[] => [...previous, value]
export const collectValues = (value: string, previous: string[]): string[] => [...previous, value]

export const validateCaseFlags = (options: { json?: boolean; ignoreCase?: boolean; caseSensitive?: boolean }): boolean => {
	if (options.ignoreCase && options.caseSensitive) {
		return usageError(options, 'Cannot combine --ignore-case with --case-sensitive.')
	}
	return true
}

export const validateMatchOptions = (options: { json?: boolean; match?: string[] }): boolean => {
	if (!options.match || options.match.length === 0) {
		return true
	}

	const invalid = options.match.find((value) => value.trim().length === 0)
	if (invalid != null) {
		return usageError(options, 'Invalid --match value: empty pattern.')
	}
	options.match = options.match.map((value) => value.trim())
	return true
}
