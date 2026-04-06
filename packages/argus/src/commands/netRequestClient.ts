import type {
	ErrorResponse,
	NetResponse,
	NetRequestBodyPart,
	NetRequestBodyResponse,
	NetRequestResponse,
	NetworkRequestSummary,
	NetworkRequestDetail,
	WatcherRecord,
} from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { fetchWatcherJson, formatWatcherTransportError, writeErrorResponse } from '../watchers/requestWatcher.js'

const NET_REQUEST_TIMEOUT_MS = 5_000
const NET_REQUEST_BODY_TIMEOUT_MS = 10_000

/**
 * Fetch one buffered network request detail record from a resolved watcher.
 * API errors are written to output and normalized to `null` so commands stay linear.
 */
export const fetchNetRequestDetail = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	query: URLSearchParams,
	output: Output,
): Promise<NetworkRequestDetail | null> => {
	const response = await fetchNetRequestRoute<NetRequestResponse>(watcher, '/net/request', query, NET_REQUEST_TIMEOUT_MS, output)
	if (!response || !response.ok) {
		return null
	}

	return response.request
}

/** Fetch buffered request summaries for follow-up selection after a reload capture settles. */
export const fetchNetRequestSummaries = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	query: URLSearchParams,
	output: Output,
): Promise<NetworkRequestSummary[] | null> => {
	const response = await fetchNetRequestRoute<NetResponse>(watcher, '/net', query, NET_REQUEST_TIMEOUT_MS, output)
	if (!response || !response.ok) {
		return null
	}

	return response.requests
}

/**
 * Fetch one lazy request/response body from a resolved watcher.
 * Returns `null` for fatal output-handled failures and the raw error payload for recoverable callers.
 */
export const fetchNetRequestBody = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	query: URLSearchParams,
	part: NetRequestBodyPart,
	output: Output,
	config: { writeApiErrors?: boolean } = {},
): Promise<NetRequestBodyResponse | ErrorResponse | null> => {
	const bodyQuery = new URLSearchParams(query)
	bodyQuery.set('part', part)
	return await fetchNetRequestRoute<NetRequestBodyResponse>(watcher, '/net/request/body', bodyQuery, NET_REQUEST_BODY_TIMEOUT_MS, output, config)
}

const fetchNetRequestRoute = async <T extends { ok: true }>(
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	path: string,
	query: URLSearchParams,
	timeoutMs: number,
	output: Output,
	config: { writeApiErrors?: boolean } = {},
): Promise<T | ErrorResponse | null> => {
	try {
		const response = await fetchWatcherJson<T | ErrorResponse>(watcher, {
			path,
			query,
			timeoutMs,
			returnErrorResponse: true,
		})

		if (!response.ok) {
			if (config.writeApiErrors !== false) {
				writeErrorResponse(response, output)
			}
			return response
		}

		return response
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return null
	}
}
