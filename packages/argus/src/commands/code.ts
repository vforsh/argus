import type { CodeGrepResponse, CodeListResponse, CodeReadResponse, ErrorResponse } from '@vforsh/argus-core'
import { parseTextPattern } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import {
	formatCodeGrepSkippedResourcesWarning,
	formatCodeMatches,
	formatCodeResources,
	formatCodeStrings,
	formatPrettyCodeMatches,
} from '../output/code.js'
import { buildPrettyCodeMatches, formatRuntimeSource } from '../runtime-code/format.js'
import { extractCodeStrings } from '../runtime-code/strings.js'
import type { CodeStringFilters, CodeStringKind, CodeStringMatch, LoadedCodeResource } from '../runtime-code/types.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

const FULL_RESOURCE_CHUNK_LINES = 5_000
const DEFAULT_CODE_STRINGS_LIMIT = 200
const DEFAULT_CODE_STRINGS_MIN_LENGTH = 8

export type CodeListOptions = {
	pattern?: string
	json?: boolean
}

export type CodeReadOptions = {
	offset?: string
	limit?: string
	json?: boolean
}

export type CodeGrepOptions = {
	url?: string
	pretty?: boolean
	json?: boolean
}

export type CodeDeminifyOptions = {
	json?: boolean
}

export type CodeStringsOptions = {
	url?: string
	minLength?: string
	limit?: string
	kind?: string
	match?: string
	all?: boolean
	json?: boolean
}

type CodeOutput = ReturnType<typeof createOutput>

export const runCodeList = async (id: string | undefined, options: CodeListOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await requestCodeResources(id, output, options.pattern)
	if (!response) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (response.resources.length === 0) {
		writeNoResourcesFound(output, options.pattern)
		return
	}

	output.writeHuman(formatCodeResources(response.resources))
}

export const runCodeRead = async (id: string | undefined, url: string, options: CodeReadOptions): Promise<void> => {
	const output = createOutput(options)
	if (!requireNonEmptyText(url, 'url is required', output)) {
		return
	}

	const offset = parseOptionalInteger(options.offset, '--offset', output, { min: 0, description: 'a non-negative integer' })
	if (offset === null) {
		return
	}
	const limit = parseOptionalInteger(options.limit, '--limit', output, { min: 1, description: 'a positive integer' })
	if (limit === null) {
		return
	}

	const response = await requestCodeSlice(id, output, url, {
		offset: offset ?? undefined,
		limit: limit ?? undefined,
	})
	if (!response) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`${response.resource.type} ${response.resource.url}`)
	output.writeHuman(`Lines ${response.startLine}-${response.endLine} of ${response.totalLines}`)
	output.writeHuman(response.content)
}

export const runCodeGrep = async (id: string | undefined, pattern: string, options: CodeGrepOptions): Promise<void> => {
	const output = createOutput(options)
	if (!requireNonEmptyText(pattern, 'pattern is required', output)) {
		return
	}

	const response = await requestCodeResponse<CodeGrepResponse>(id, output, {
		id,
		path: '/code/grep',
		method: 'POST',
		body: {
			pattern,
			urlPattern: options.url,
		},
	})
	if (!response) {
		return
	}

	writeCodeGrepWarnings(response.skippedResources, output)

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (response.matches.length === 0) {
		output.writeWarn(`No matches found for ${pattern}`)
		return
	}

	if (!options.pretty) {
		output.writeHuman(formatCodeMatches(response.matches))
		return
	}

	const sourceByUrl = await loadSourcesByUrl(id, output, [...new Set(response.matches.map((match) => match.url))])
	if (!sourceByUrl) {
		return
	}

	const prettyMatches = buildPrettyCodeMatches(response.matches, sourceByUrl, parseTextPattern(pattern))
	output.writeHuman(formatPrettyCodeMatches(prettyMatches))
}

export const runCodeDeminify = async (id: string | undefined, url: string, options: CodeDeminifyOptions): Promise<void> => {
	const output = createOutput(options)
	if (!requireNonEmptyText(url, 'url is required', output)) {
		return
	}

	const loaded = await loadFullCodeResource(id, output, url)
	if (!loaded) {
		return
	}

	const formatted = await formatRuntimeSource(loaded.source, loaded.resource.type)
	const response = {
		ok: true as const,
		resource: loaded.resource,
		source: formatted.source,
		changed: formatted.changed,
		formatError: formatted.error ?? null,
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`${loaded.resource.type} ${loaded.resource.url}`)
	if (formatted.error) {
		output.writeWarn(`Formatter failed, showing original source: ${formatted.error}`)
	}
	output.writeHuman(response.source)
}

export const runCodeStrings = async (id: string | undefined, options: CodeStringsOptions): Promise<void> => {
	const output = createOutput(options)
	const parsedMinLength = parseOptionalInteger(options.minLength, '--min-length', output, {
		min: 1,
		description: 'a positive integer',
	})
	if (parsedMinLength === null) {
		return
	}
	const parsedLimit = parseOptionalInteger(options.limit, '--limit', output, { min: 1, description: 'a positive integer' })
	if (parsedLimit === null) {
		return
	}
	const minLength = parsedMinLength ?? DEFAULT_CODE_STRINGS_MIN_LENGTH
	const limit = parsedLimit ?? DEFAULT_CODE_STRINGS_LIMIT
	const filters = parseCodeStringFilters(options, output)
	if (filters === null) {
		return
	}

	const listResponse = await requestCodeResources(id, output, options.url)
	if (!listResponse) {
		return
	}

	if (listResponse.resources.length === 0) {
		writeNoResourcesFound(output, options.url)
		return
	}

	const matches: CodeStringMatch[] = []
	for (const resource of listResponse.resources) {
		const loaded = await loadFullCodeResource(id, output, resource.url)
		if (!loaded) {
			return
		}

		const extracted = extractCodeStrings(
			{
				source: loaded.source,
				type: loaded.resource.type,
				url: loaded.resource.url,
			},
			{
				minLength,
				includeAll: options.all ?? false,
				filters,
			},
		)

		matches.push(...extracted)
	}

	const limitedMatches = matches.slice(0, limit)

	const response = {
		ok: true as const,
		matches: limitedMatches,
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (limitedMatches.length === 0) {
		output.writeWarn('No interesting strings found.')
		return
	}

	output.writeHuman(formatCodeStrings(limitedMatches))
}

const requireNonEmptyText = (value: string, message: string, output: CodeOutput): boolean => {
	if (value.trim()) {
		return true
	}

	output.writeWarn(message)
	process.exitCode = 2
	return false
}

const parseOptionalInteger = (
	value: string | undefined,
	flag: string,
	output: CodeOutput,
	options: { min: number; description: string },
): number | undefined | null => {
	if (value === undefined) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < options.min) {
		output.writeWarn(`${flag} must be ${options.description}`)
		process.exitCode = 2
		return null
	}

	return parsed
}

const requestCodeSlice = async (
	id: string | undefined,
	output: CodeOutput,
	url: string,
	options: { offset?: number; limit?: number },
): Promise<CodeReadResponse | null> =>
	requestCodeResponse<CodeReadResponse>(id, output, {
		id,
		path: '/code/read',
		method: 'POST',
		body: {
			url,
			offset: options.offset,
			limit: options.limit,
		},
	})

const requestCodeResources = (id: string | undefined, output: CodeOutput, pattern?: string): Promise<CodeListResponse | null> =>
	requestCodeResponse<CodeListResponse>(id, output, {
		id,
		path: '/code/list',
		method: 'POST',
		body: {
			pattern,
		},
	})

const loadFullCodeResource = async (id: string | undefined, output: CodeOutput, url: string): Promise<LoadedCodeResource | null> => {
	const firstChunk = await requestCodeSlice(id, output, url, {
		offset: 0,
		limit: FULL_RESOURCE_CHUNK_LINES,
	})
	if (!firstChunk) {
		return null
	}

	const chunks = [firstChunk.source]
	let offset = firstChunk.endLine

	while (offset < firstChunk.totalLines) {
		const nextChunk = await requestCodeSlice(id, output, url, {
			offset,
			limit: FULL_RESOURCE_CHUNK_LINES,
		})
		if (!nextChunk) {
			return null
		}

		chunks.push(nextChunk.source)
		offset = nextChunk.endLine
	}

	return {
		resource: firstChunk.resource,
		source: chunks.join('\n'),
	}
}

const loadSourcesByUrl = async (id: string | undefined, output: CodeOutput, urls: string[]): Promise<Map<string, string> | null> => {
	const sourceByUrl = new Map<string, string>()

	for (const url of urls) {
		const loaded = await loadFullCodeResource(id, output, url)
		if (!loaded) {
			return null
		}
		sourceByUrl.set(url, loaded.source)
	}

	return sourceByUrl
}

const parseCodeStringFilters = (options: CodeStringsOptions, output: CodeOutput): CodeStringFilters | null => {
	const kinds = parseCodeStringKinds(options.kind, output)
	if (kinds === null) {
		return null
	}

	return {
		kinds: kinds ?? undefined,
		matchPattern: options.match?.trim() ? options.match : undefined,
	}
}

const parseCodeStringKinds = (value: string | undefined, output: CodeOutput): Set<CodeStringKind> | undefined | null => {
	if (!value?.trim()) {
		return undefined
	}

	const allowedKinds = new Set<CodeStringKind>(['url', 'key', 'identifier', 'message', 'other'])
	const kinds = new Set<CodeStringKind>()

	for (const rawKind of value.split(',')) {
		const kind = rawKind.trim() as CodeStringKind
		if (!kind) {
			continue
		}
		if (!allowedKinds.has(kind)) {
			output.writeWarn(`--kind must be a comma-separated list of: ${[...allowedKinds].join(', ')}`)
			process.exitCode = 2
			return null
		}
		kinds.add(kind)
	}

	if (kinds.size === 0) {
		output.writeWarn('--kind must include at least one value')
		process.exitCode = 2
		return null
	}

	return kinds
}

const writeNoResourcesFound = (output: CodeOutput, pattern?: string): void => {
	output.writeWarn(pattern ? `No runtime resources matched: ${pattern}` : 'No runtime resources discovered.')
}

const writeCodeGrepWarnings = (skippedResources: CodeGrepResponse['skippedResources'], output: CodeOutput): void => {
	const warning = formatCodeGrepSkippedResourcesWarning(skippedResources)
	if (!warning) {
		return
	}

	output.writeWarn(warning)
}

const writeErrorResponse = (response: ErrorResponse, output: CodeOutput): void => {
	if (output.json) {
		output.writeJson(response)
	} else {
		output.writeWarn(`Error: ${response.error.message}`)
	}
	process.exitCode = 1
}

const requestCodeResponse = async <T extends { ok: true }>(
	id: string | undefined,
	output: CodeOutput,
	input: {
		id?: string
		path: string
		method: 'POST'
		body: unknown
	},
): Promise<T | null> => {
	const result = await requestWatcherJson<T | ErrorResponse>({
		...input,
		id,
		timeoutMs: 30_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	if (!result.data.ok) {
		writeErrorResponse(result.data as ErrorResponse, output)
		return null
	}

	return result.data as T
}
