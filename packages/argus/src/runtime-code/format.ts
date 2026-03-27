import { findTextPatternMatch, type CodeResourceType, type TextPattern } from '@vforsh/argus-core'
import type { CodeGrepMatch } from '@vforsh/argus-core'
import prettier from 'prettier/standalone'
import babelPlugin from 'prettier/plugins/babel'
import estreePlugin from 'prettier/plugins/estree'
import postcssPlugin from 'prettier/plugins/postcss'
import type { PrettyCodeLine, PrettyCodeMatch, RuntimeSourceFormatResult } from './types.js'

const PRETTY_CONTEXT_BEFORE = 1
const PRETTY_CONTEXT_AFTER = 1
const MAX_PRETTY_LINE_WIDTH = 160

const PRETTIER_PLUGINS = [babelPlugin, estreePlugin, postcssPlugin]

export const formatRuntimeSource = async (source: string, type: CodeResourceType): Promise<RuntimeSourceFormatResult> => {
	const parser = getPrettierParser(type)
	if (!parser) {
		return { source, changed: false }
	}

	try {
		const formatted = await prettier.format(source, {
			parser,
			plugins: PRETTIER_PLUGINS,
		})
		return {
			source: formatted,
			changed: formatted !== source,
		}
	} catch (error) {
		return {
			source,
			changed: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export const buildPrettyCodeMatches = (matches: CodeGrepMatch[], sourceByUrl: Map<string, string>, pattern: TextPattern): PrettyCodeMatch[] =>
	matches.map((match) => {
		const source = sourceByUrl.get(match.url) ?? ''
		const lines = source.split('\n')
		const currentIndex = Math.max(0, match.lineNumber - 1)
		const startIndex = Math.max(0, currentIndex - PRETTY_CONTEXT_BEFORE)
		const endIndex = Math.min(lines.length, currentIndex + PRETTY_CONTEXT_AFTER + 1)
		const snippet: PrettyCodeLine[] = []

		for (let index = startIndex; index < endIndex; index++) {
			const rawLine = lines[index] ?? ''
			const isMatch = index === currentIndex
			const matchRange = isMatch ? findTextPatternMatch(rawLine, pattern) : null
			snippet.push({
				lineNumber: index + 1,
				content: formatSnippetLine(rawLine, matchRange),
				isMatch,
			})
		}

		return {
			...match,
			snippet,
		}
	})

const getPrettierParser = (type: CodeResourceType): 'babel' | 'css' | null => {
	switch (type) {
		case 'script':
			return 'babel'
		case 'stylesheet':
			return 'css'
		default:
			return null
	}
}

const formatSnippetLine = (line: string, match: { index: number; length: number } | null): string => {
	if (!match) {
		return clipLine(line)
	}

	if (line.length <= MAX_PRETTY_LINE_WIDTH) {
		return injectMatchMarkers(line, match.index, match.length)
	}

	const windowStart = Math.max(0, match.index - 50)
	const windowEnd = Math.min(line.length, match.index + match.length + 70)
	const prefix = windowStart > 0 ? '...' : ''
	const suffix = windowEnd < line.length ? '...' : ''
	const sliced = line.slice(windowStart, windowEnd)
	return `${prefix}${injectMatchMarkers(sliced, match.index - windowStart, match.length)}${suffix}`
}

const clipLine = (line: string): string => {
	if (line.length <= MAX_PRETTY_LINE_WIDTH) {
		return line
	}

	return `${line.slice(0, MAX_PRETTY_LINE_WIDTH - 3)}...`
}

const injectMatchMarkers = (line: string, index: number, length: number): string => {
	const safeLength = Math.max(1, length)
	return `${line.slice(0, index)}[[${line.slice(index, index + safeLength)}]]${line.slice(index + safeLength)}`
}
