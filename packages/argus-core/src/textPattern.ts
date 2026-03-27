export type TextPattern = { type: 'exact'; value: string } | { type: 'regex'; regex: RegExp }

const REGEX_PATTERN = /^\/(.+)\/([imsu]*)$/

/**
 * Parse a plain string or `/regex/flags` value into a reusable text pattern.
 */
export const parseTextPattern = (text: string): TextPattern => {
	const match = REGEX_PATTERN.exec(text)
	if (!match) {
		return { type: 'exact', value: text }
	}

	const [, pattern, flags] = match
	try {
		return { type: 'regex', regex: new RegExp(pattern!, flags) }
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid regex pattern "${text}": ${msg}`)
	}
}

/**
 * Test whether a line matches a parsed text pattern.
 */
export const matchesTextPattern = (line: string, pattern: TextPattern): boolean => {
	if (pattern.type === 'exact') {
		return line.includes(pattern.value)
	}

	const matched = pattern.regex.test(line)
	pattern.regex.lastIndex = 0
	return matched
}

/**
 * Find the first match range for a parsed text pattern within a line.
 */
export const findTextPatternMatch = (line: string, pattern: TextPattern): { index: number; length: number } | null => {
	if (pattern.type === 'exact') {
		const index = line.indexOf(pattern.value)
		return index >= 0 ? { index, length: pattern.value.length } : null
	}

	const matched = pattern.regex.exec(line)
	pattern.regex.lastIndex = 0
	if (!matched || matched.index < 0) {
		return null
	}

	return {
		index: matched.index,
		length: Math.max(1, matched[0]?.length ?? 0),
	}
}
