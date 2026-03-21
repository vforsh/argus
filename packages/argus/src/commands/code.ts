import type { CodeGrepResponse, CodeListResponse, CodeReadResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { formatCodeMatches, formatCodeResources } from '../output/code.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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
	json?: boolean
}

type CodeOutput = ReturnType<typeof createOutput>

export const runCodeList = async (id: string | undefined, options: CodeListOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await requestCodeResponse<CodeListResponse>(id, output, {
		id,
		path: '/code/list',
		method: 'POST',
		body: {
			pattern: options.pattern,
		},
	})
	if (!response) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (response.resources.length === 0) {
		output.writeWarn(options.pattern ? `No runtime resources matched: ${options.pattern}` : 'No runtime resources discovered.')
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

	const response = await requestCodeResponse<CodeReadResponse>(id, output, {
		id,
		path: '/code/read',
		method: 'POST',
		body: {
			url,
			offset: offset ?? undefined,
			limit: limit ?? undefined,
		},
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

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (response.matches.length === 0) {
		output.writeWarn(`No matches found for ${pattern}`)
		return
	}

	output.writeHuman(formatCodeMatches(response.matches))
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
