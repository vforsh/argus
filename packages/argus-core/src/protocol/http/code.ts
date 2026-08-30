import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, fieldError, optionalInteger, optionalNonEmptyString, readFields, requireObject, requiredString } from '../schemaFields.js'

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

/** Request payload for POST /code/edit. */
export type CodeEditRequest = {
	/** Resource URL from /code/list. */
	url: string
	/** Full replacement source text. */
	source: string
}

/** Response payload for POST /code/edit. */
export type CodeEditResponse = {
	ok: true
	resource: CodeResource
}

/** Schema for POST /code/list request payloads. */
export const codeListRequestSchema = defineProtocolSchema<CodeListRequest>((value) => {
	const invalid = requireObject<CodeListRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, { pattern: optionalNonEmptyString })
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /code/read request payloads. */
export const codeReadRequestSchema = defineProtocolSchema<CodeReadRequest>((value) => {
	const invalid = requireObject<CodeReadRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		url: requiredString,
		offset: (source, key) => optionalInteger(source, key, { min: 0 }),
		limit: (source, key) => optionalInteger(source, key, { min: 1 }),
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /code/grep request payloads. */
export const codeGrepRequestSchema = defineProtocolSchema<CodeGrepRequest>((value) => {
	const invalid = requireObject<CodeGrepRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		pattern: requiredString,
		urlPattern: optionalNonEmptyString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /code/edit request payloads. */
export const codeEditRequestSchema = defineProtocolSchema<CodeEditRequest>((value) => {
	const invalid = requireObject<CodeEditRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		url: requiredString,
		// Empty source is legal: it clears the resource.
		source: (source, key) => (typeof source[key] === 'string' ? (source[key] as string) : fieldError('source must be a string')),
	})
	if (!fields.ok) return fields

	return validProtocolPayload(fields.value)
})
