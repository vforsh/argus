import {
	CODE_GREP_AUTO_EXCERPT_LINE_LENGTH,
	CODE_GREP_DEFAULT_AROUND,
	findTextPatternMatches,
	matchesTextPattern,
	type CodeGrepMatch,
	type TextPattern,
} from '@vforsh/argus-core'

/** Grep options that shape how one line's matches are reported. */
export type GrepLineOptions = {
	/** Context characters per side; forces excerpts. Omitted: only long lines are excerpted. */
	around?: number
	maxPerLine: number
}

/**
 * Report one source line's matches: the whole line once, or — for a long line or an explicit
 * `around` — one excerpt per match. Minified bundles are a single line of up to a megabyte, so
 * returning it whole for every hit made grep output unreadable and huge.
 */
export const grepLine = (
	resource: Pick<CodeGrepMatch, 'url' | 'type'>,
	line: string,
	lineNumber: number,
	pattern: TextPattern,
	options: GrepLineOptions,
): CodeGrepMatch[] => {
	const base = { url: resource.url, type: resource.type, lineNumber }
	const context = options.around ?? (line.length > CODE_GREP_AUTO_EXCERPT_LINE_LENGTH ? CODE_GREP_DEFAULT_AROUND : null)
	if (context == null) {
		return matchesTextPattern(line, pattern) ? [{ ...base, lineContent: line }] : []
	}

	return findTextPatternMatches(line, pattern, options.maxPerLine).map((range) => {
		const start = Math.max(0, range.index - context)
		const end = Math.min(line.length, range.index + range.length + context)
		return {
			...base,
			lineContent: line.slice(start, end),
			column: range.index + 1,
			matchLength: range.length,
			excerpt: { start, end, lineLength: line.length },
		}
	})
}
