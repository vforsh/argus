import type { Output } from '../output/io.js'

/**
 * Accept either an Argus numeric buffer id or a raw CDP request id and turn it into watcher query params.
 */
export const buildNetRequestLookupQuery = (request: string, output: Output): URLSearchParams | null => {
	const resolved = resolveNetRequestLookupQuery(request)
	if (resolved.query) {
		return resolved.query
	}

	output.writeWarn(resolved.error)
	process.exitCode = 2
	return null
}

/** Parse a CLI request selector into watcher query params. */
export const resolveNetRequestLookupQuery = (request: string): { query: URLSearchParams; error?: never } | { error: string; query?: never } => {
	const normalizedRequest = request.trim()
	if (!normalizedRequest) {
		return { error: 'request id is required' }
	}

	const query = new URLSearchParams()
	const numericId = parseNetRequestBufferId(normalizedRequest)
	if (numericId != null) {
		query.set('id', String(numericId))
	} else {
		query.set('requestId', normalizedRequest)
	}

	return { query }
}

const parseNetRequestBufferId = (value: string): number | null => {
	if (!/^\d+$/.test(value)) {
		return null
	}

	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
