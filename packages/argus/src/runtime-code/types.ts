import type { CodeGrepMatch, CodeResource, CodeResourceType } from '@vforsh/argus-core'

export type LoadedCodeResource = {
	resource: CodeResource
	source: string
}

export type RuntimeSourceFormatResult = {
	source: string
	changed: boolean
	error?: string
}

export type PrettyCodeLine = {
	lineNumber: number
	content: string
	isMatch: boolean
}

export type PrettyCodeMatch = CodeGrepMatch & {
	snippet: PrettyCodeLine[]
}

export type CodeStringKind = 'url' | 'key' | 'identifier' | 'message' | 'other'

export type CodeStringFilters = {
	kinds?: Set<CodeStringKind>
	matchPattern?: string
}

export type CodeStringMatch = {
	url: string
	type: CodeResourceType
	lineNumber: number
	kind: CodeStringKind
	value: string
}
