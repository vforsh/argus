import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, fieldError, optionalInteger, optionalNonEmptyString, readFields, requireObject, requiredString } from '../schemaFields.js'
import type { Ok } from './errors.js'

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
export type CodeListResponse = Ok<{
	resources: CodeResource[]
}>

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
export type CodeReadResponse = Ok<{
	resource: CodeResource
	/** Raw source text for the requested line slice. */
	source: string
	content: string
	totalLines: number
	startLine: number
	endLine: number
}>

/** Request payload for POST /code/grep. */
export type CodeGrepRequest = {
	/** Plain string or /regex/flags pattern to match within source lines. */
	pattern: string
	/** Optional case-insensitive substring filter over resource URLs. */
	urlPattern?: string
	/**
	 * Characters of context kept on each side of a match. When set, every match is reported as an
	 * excerpt; when omitted, only lines longer than {@link CODE_GREP_AUTO_EXCERPT_LINE_LENGTH} are
	 * (with {@link CODE_GREP_DEFAULT_AROUND}), so a minified bundle's one-megabyte line never ships whole.
	 */
	around?: number
	/** Most matches reported per excerpted line (default {@link CODE_GREP_DEFAULT_MAX_PER_LINE}). */
	maxPerLine?: number
}

/** Lines longer than this are excerpted around each match even without `around`. */
export const CODE_GREP_AUTO_EXCERPT_LINE_LENGTH = 2_000
/** Context characters per side for automatic excerpts. */
export const CODE_GREP_DEFAULT_AROUND = 200
/** Default cap on matches reported from one excerpted line. */
export const CODE_GREP_DEFAULT_MAX_PER_LINE = 10

/** One grep match inside a runtime resource. */
export type CodeGrepMatch = {
	url: string
	type: CodeResourceType
	lineNumber: number
	/** The whole line, or only the excerpt around the match when `excerpt` is set. */
	lineContent: string
	/** 1-based column where the match starts. Set on excerpted matches. */
	column?: number
	/** Length of the matched text. Set on excerpted matches. */
	matchLength?: number
	/** Where `lineContent` sits in the line: `[start, end)` character offsets, plus the full line length. */
	excerpt?: { start: number; end: number; lineLength: number }
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
export type CodeGrepResponse = Ok<{
	matches: CodeGrepMatch[]
	/** Non-fatal runtime resources skipped while searching. */
	skippedResources: CodeGrepSkippedResource[]
}>

/** Request payload for POST /code/edit. */
export type CodeEditRequest = {
	/** Resource URL from /code/list. */
	url: string
	/** Full replacement source text. */
	source: string
}

/** Response payload for POST /code/edit. */
export type CodeEditResponse = Ok<{
	resource: CodeResource
}>

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
		around: (source, key) => optionalInteger(source, key, { min: 0, max: 10_000 }),
		maxPerLine: (source, key) => optionalInteger(source, key, { min: 1, max: 500 }),
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
