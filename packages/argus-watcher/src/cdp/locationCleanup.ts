export const stripUrlPrefixes = (file: string, prefixes: string[] | undefined): string => {
	if (!file || !Array.isArray(prefixes) || prefixes.length === 0) {
		return file
	}
	for (const prefix of prefixes) {
		if (typeof prefix !== 'string') {
			continue
		}
		const trimmed = prefix.trim()
		if (!trimmed) {
			continue
		}
		if (file.startsWith(trimmed)) {
			return file.slice(trimmed.length)
		}
	}
	return file
}
