import type { CodeGrepMatch, CodeResource } from '@vforsh/argus-core'
import type { CodeStringMatch, PrettyCodeMatch } from '../runtime-code/types.js'

export const formatCodeResources = (resources: CodeResource[]): string => {
	return resources.map((resource) => `${resource.type.padEnd(10)} ${resource.url}`).join('\n')
}

export const formatCodeMatches = (matches: CodeGrepMatch[]): string => {
	return matches.map((match) => `${match.type.padEnd(10)} ${match.url}:${match.lineNumber}\n  ${match.lineContent}`).join('\n')
}

export const formatPrettyCodeMatches = (matches: PrettyCodeMatch[]): string =>
	matches
		.map((match) => {
			const snippet = match.snippet
				.map((line) => `${line.isMatch ? '>' : ' '} ${String(line.lineNumber).padStart(5)}| ${line.content}`)
				.join('\n')
			return `${match.type.padEnd(10)} ${match.url}:${match.lineNumber}\n${snippet}`
		})
		.join('\n\n')

export const formatCodeStrings = (matches: CodeStringMatch[]): string =>
	matches.map((match) => `${match.type.padEnd(10)} ${match.url}:${match.lineNumber} [${match.kind}] ${match.value}`).join('\n')
