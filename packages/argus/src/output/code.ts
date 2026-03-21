import type { CodeGrepMatch, CodeResource } from '@vforsh/argus-core'

export const formatCodeResources = (resources: CodeResource[]): string => {
	return resources.map((resource) => `${resource.type.padEnd(10)} ${resource.url}`).join('\n')
}

export const formatCodeMatches = (matches: CodeGrepMatch[]): string => {
	return matches.map((match) => `${match.type.padEnd(10)} ${match.url}:${match.lineNumber}\n  ${match.lineContent}`).join('\n')
}
