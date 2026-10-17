import { formatError } from './errorMessage.js'
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
		const msg = formatError(error)
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

/**
 * Find up to `limit` non-overlapping match ranges within a line, left to right.
 */
export const findTextPatternMatches = (line: string, pattern: TextPattern, limit: number): Array<{ index: number; length: number }> => {
	const ranges: Array<{ index: number; length: number }> = []
	if (pattern.type === 'exact') {
		if (pattern.value === '') return limit > 0 ? [{ index: 0, length: 0 }] : ranges
		for (let index = line.indexOf(pattern.value); index >= 0 && ranges.length < limit; index = line.indexOf(pattern.value, index + pattern.value.length)) {
			ranges.push({ index, length: pattern.value.length })
		}
		return ranges
	}

	const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`)
	for (let matched = regex.exec(line); matched && ranges.length < limit; matched = regex.exec(line)) {
		ranges.push({ index: matched.index, length: matched[0].length })
		if (matched[0].length > 0) continue
		if (matched.index >= line.length) break
		// Step past an empty match by a whole code point, or a `u` regex re-matches inside a surrogate pair.
		regex.lastIndex = matched.index + (line.codePointAt(matched.index)! > 0xffff ? 2 : 1)
	}
	return ranges
}
