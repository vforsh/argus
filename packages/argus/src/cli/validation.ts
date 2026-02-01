export const collectMatch = (value: string, previous: string[]): string[] => [...previous, value]
export const collectParam = (value: string, previous: string[]): string[] => [...previous, value]

export const validateCaseFlags = (options: { ignoreCase?: boolean; caseSensitive?: boolean }): boolean => {
	if (options.ignoreCase && options.caseSensitive) {
		console.error('Cannot combine --ignore-case with --case-sensitive.')
		process.exitCode = 2
		return false
	}
	return true
}

export const validateMatchOptions = (options: { match?: string[] }): boolean => {
	if (!options.match || options.match.length === 0) {
		return true
	}

	const invalid = options.match.find((value) => value.trim().length === 0)
	if (invalid != null) {
		console.error('Invalid --match value: empty pattern.')
		process.exitCode = 2
		return false
	}
	options.match = options.match.map((value) => value.trim())
	return true
}
