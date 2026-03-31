/** Runtime resource type exposed by the live runtime-code API. */
export type CodeResourceType = 'script' | 'stylesheet'

/** Runtime script/stylesheet metadata. */
export type CodeResource = {
	/** Stable-enough runtime URL or synthetic inline URL. */
	url: string
	/** Resource kind. */
	type: CodeResourceType
}

/** Request payload for POST /code/list. */
export type CodeListRequest = {
	/** Optional case-insensitive substring filter over URLs. */
	pattern?: string
}

/** Response payload for POST /code/list. */
export type CodeListResponse = {
	ok: true
	resources: CodeResource[]
}

/** Request payload for POST /code/read. */
export type CodeReadRequest = {
	/** Resource URL from /code/list. */
	url: string
	/** Zero-based line offset. Defaults to 0. */
	offset?: number
	/** Max lines to return. Defaults to 2000. */
	limit?: number
}

/** Response payload for POST /code/read. */
export type CodeReadResponse = {
	ok: true
	resource: CodeResource
	/** Raw source text for the requested line slice. */
	source: string
	content: string
	totalLines: number
	startLine: number
	endLine: number
}

/** Request payload for POST /code/grep. */
export type CodeGrepRequest = {
	/** Plain string or /regex/flags pattern to match within source lines. */
	pattern: string
	/** Optional case-insensitive substring filter over resource URLs. */
	urlPattern?: string
}

/** One grep match inside a runtime resource. */
export type CodeGrepMatch = {
	url: string
	type: CodeResourceType
	lineNumber: number
	lineContent: string
}

/** Runtime resource skipped during grep because its live handle could not be read. */
export type CodeGrepSkippedResource = {
	/** Runtime resource URL originally discovered via `code ls`. */
	url: string
	/** Resource kind. */
	type: CodeResourceType
	/** Human-readable read failure reason. */
	reason: string
}

/** Response payload for POST /code/grep. */
export type CodeGrepResponse = {
	ok: true
	matches: CodeGrepMatch[]
	/** Non-fatal runtime resources skipped while searching. */
	skippedResources: CodeGrepSkippedResource[]
}
