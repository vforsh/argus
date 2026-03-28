import { findTextPatternMatch, parseTextPattern } from '@vforsh/argus-core'
import type { CodeResourceType } from '@vforsh/argus-core'
import type { CodeStringFilters, CodeStringKind, CodeStringMatch } from './types.js'

type ExtractedLiteral = {
	value: string
	lineNumber: number
}

export type ExtractCodeStringsOptions = {
	minLength: number
	includeAll: boolean
	filters?: CodeStringFilters
}

export const extractCodeStrings = (
	input: {
		source: string
		type: CodeResourceType
		url: string
	},
	options: ExtractCodeStringsOptions,
): CodeStringMatch[] => {
	const literals = collectStringLiterals(input.source)
	const matchPattern = options.filters?.matchPattern ? parseTextPattern(options.filters.matchPattern) : undefined
	const seen = new Set<string>()
	const matches: CodeStringMatch[] = []

	for (const literal of literals) {
		const value = literal.value.trim()
		if (value.length < options.minLength) {
			continue
		}

		const kind = classifyCodeString(value, options.includeAll)
		if (!kind) {
			continue
		}

		if (options.filters?.kinds && !options.filters.kinds.has(kind)) {
			continue
		}

		if (matchPattern && !findTextPatternMatch(value, matchPattern)) {
			continue
		}

		if (seen.has(value)) {
			continue
		}
		seen.add(value)

		matches.push({
			url: input.url,
			type: input.type,
			lineNumber: literal.lineNumber,
			kind,
			value,
		})
	}

	return rankCodeStrings(matches)
}

const collectStringLiterals = (source: string): ExtractedLiteral[] => {
	const literals: ExtractedLiteral[] = []
	let index = 0
	let lineNumber = 1

	while (index < source.length) {
		const char = source[index]!
		const next = source[index + 1]

		if (char === '\n') {
			lineNumber += 1
			index += 1
			continue
		}

		if (char === '/' && next === '/') {
			index += 2
			while (index < source.length && source[index] !== '\n') {
				index += 1
			}
			continue
		}

		if (char === '/' && next === '*') {
			index += 2
			while (index < source.length) {
				if (source[index] === '\n') {
					lineNumber += 1
				}
				if (source[index] === '*' && source[index + 1] === '/') {
					index += 2
					break
				}
				index += 1
			}
			continue
		}

		if (char === '"' || char === "'" || char === '`') {
			const literal = readQuotedLiteral(source, index, lineNumber, char)
			index = literal.nextIndex
			lineNumber = literal.lineNumber
			if (literal.value != null) {
				literals.push({
					value: literal.value,
					lineNumber: literal.startLineNumber,
				})
			}
			continue
		}

		index += 1
	}

	return literals
}

const readQuotedLiteral = (
	source: string,
	startIndex: number,
	startLineNumber: number,
	quote: '"' | "'" | '`',
): {
	value: string | null
	nextIndex: number
	lineNumber: number
	startLineNumber: number
} => {
	let index = startIndex + 1
	let lineNumber = startLineNumber
	let escaped = false
	let dynamicTemplate = false
	let value = ''

	while (index < source.length) {
		const char = source[index]!
		const next = source[index + 1]

		if (escaped) {
			value += char
			escaped = false
			if (char === '\n') {
				lineNumber += 1
			}
			index += 1
			continue
		}

		if (char === '\\') {
			escaped = true
			index += 1
			continue
		}

		if (char === '\n') {
			lineNumber += 1
			if (quote !== '`') {
				return { value: null, nextIndex: index + 1, lineNumber, startLineNumber }
			}
		}

		if (quote === '`' && char === '$' && next === '{') {
			dynamicTemplate = true
		}

		if (char === quote) {
			return {
				value: dynamicTemplate ? null : value,
				nextIndex: index + 1,
				lineNumber,
				startLineNumber,
			}
		}

		value += char
		index += 1
	}

	return { value: null, nextIndex: index, lineNumber, startLineNumber }
}

const classifyCodeString = (value: string, includeAll: boolean): CodeStringKind | null => {
	if (hasControlChars(value)) {
		return null
	}

	const kind = detectInterestingKind(value)
	if (kind) {
		return kind
	}

	return includeAll ? 'other' : null
}

const detectInterestingKind = (value: string): CodeStringKind | null => {
	if (/^(https?:\/\/|\/|\.{1,2}\/)/.test(value) || value.includes('/api/')) {
		return 'url'
	}

	if (!/\s/.test(value) && /^[A-Za-z0-9_$.:/-]+$/.test(value) && /[:._-]/.test(value)) {
		return 'key'
	}

	if (!/\s/.test(value) && /^[A-Za-z_$][A-Za-z0-9_$]+$/.test(value) && /[a-z][A-Z]/.test(value)) {
		return 'identifier'
	}

	if (/\s/.test(value) && /[A-Za-z]/.test(value) && value.length >= 16) {
		return 'message'
	}

	return null
}

const hasControlChars = (value: string): boolean => {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) < 32) {
			return true
		}
	}
	return false
}

type ScoredCodeStringMatch = CodeStringMatch & {
	score: number
}

const rankCodeStrings = (matches: CodeStringMatch[]): CodeStringMatch[] =>
	matches
		.map((match) => ({
			...match,
			score: scoreCodeString(match),
		}))
		.sort(compareCodeStringMatches)
		.map(({ score: _score, ...match }) => match)

/**
 * Prefer strings that usually help reverse-engineering real apps:
 * API paths, camelCase endpoint names, storage keys, and readable messages.
 * Generic webpack/module paths still show up, just lower in the list.
 */
const scoreCodeString = (match: CodeStringMatch): number => {
	const value = match.value
	let score = baseKindScore(match.kind)

	if (value.includes('/api/')) {
		score += 60
	}
	if (/^\/admin\//.test(value)) {
		score += 35
	}
	if (/^[A-Za-z_$][A-Za-z0-9_$]+$/.test(value) && /[a-z][A-Z]/.test(value)) {
		score += 28
	}
	if (/^[A-Za-z0-9_$.-]+:[A-Za-z0-9_$./-]+$/.test(value)) {
		score += 24
	}
	if (/\s/.test(value) && /[A-Za-z]/.test(value) && value.length >= 24) {
		score += 18
	}

	if (/^\.\.?\/[^/\s]+(?:\/[^/\s]+)*\.[A-Za-z0-9]+$/.test(value)) {
		score -= 75
	}
	if (/^\.\/[a-z]{2}(?:-[a-z]{2})?\.js$/i.test(value)) {
		score -= 90
	}
	if (/^(?:chunk|module|vendor)[-./_]/i.test(value)) {
		score -= 20
	}

	return score
}

const baseKindScore = (kind: CodeStringKind): number => {
	switch (kind) {
		case 'url':
			return 140
		case 'identifier':
			return 115
		case 'key':
			return 100
		case 'message':
			return 90
		case 'other':
			return 10
	}
}

const compareCodeStringMatches = (left: ScoredCodeStringMatch, right: ScoredCodeStringMatch): number => {
	if (right.score !== left.score) {
		return right.score - left.score
	}
	if (left.kind !== right.kind) {
		return left.kind.localeCompare(right.kind)
	}
	if (left.url !== right.url) {
		return left.url.localeCompare(right.url)
	}
	if (left.lineNumber !== right.lineNumber) {
		return left.lineNumber - right.lineNumber
	}
	return left.value.localeCompare(right.value)
}
