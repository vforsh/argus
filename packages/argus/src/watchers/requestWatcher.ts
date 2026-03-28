import type { ErrorResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import type { HttpOptions } from '../httpClient.js'
import { fetchJson } from '../httpClient.js'
import { formatError } from '../cli/parse.js'
import { formatWatcherLine } from '../output/format.js'
import { resolveWatcher } from './resolveWatcher.js'

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

/** Input for a one-shot watcher request. */
export type WatcherRequestInput = {
	id?: string
	path: string
	query?: URLSearchParams
	method?: HttpOptions['method']
	body?: unknown
	timeoutMs?: number
	returnErrorResponse?: boolean
}

/** Successful watcher request. */
export type WatcherRequestSuccess<T> = {
	ok: true
	watcher: WatcherRecord
	data: T
}

/** Failed watcher request (resolve failure or transport error). */
export type WatcherRequestError = {
	ok: false
	watcher?: WatcherRecord
	exitCode: number
	message: string
	candidates?: WatcherRecord[]
}

export type WatcherRequestResult<T> = WatcherRequestSuccess<T> | WatcherRequestError

export const buildWatcherUrl = (watcher: Pick<WatcherRecord, 'host' | 'port'>, path: string, query?: URLSearchParams): string => {
	const qs = query?.toString()
	return `http://${watcher.host}:${watcher.port}${path}${qs ? `?${qs}` : ''}`
}

export const formatWatcherTransportError = (watcher: Pick<WatcherRecord, 'id'>, error: unknown): string =>
	`${watcher.id}: failed to reach watcher (${formatError(error)})`

export async function fetchWatcherJson<T>(watcher: Pick<WatcherRecord, 'host' | 'port'>, input: Omit<WatcherRequestInput, 'id'>): Promise<T> {
	return fetchJson<T>(buildWatcherUrl(watcher, input.path, input.query), {
		method: input.method,
		body: input.body,
		timeoutMs: input.timeoutMs,
		returnErrorResponse: input.returnErrorResponse,
	})
}

/**
 * Resolve a watcher, build a URL, and fetch JSON in one call.
 * Handles resolve failures and transport errors uniformly.
 */
export async function requestWatcherJson<T>(input: WatcherRequestInput): Promise<WatcherRequestResult<T>> {
	const resolved = await resolveWatcher({ id: input.id })
	if (!resolved.ok) {
		return {
			ok: false,
			exitCode: resolved.exitCode,
			message: resolved.error,
			candidates: resolved.candidates,
		}
	}

	const { watcher } = resolved

	try {
		const data = await fetchWatcherJson<T>(watcher, input)
		return { ok: true, watcher, data }
	} catch (error) {
		return {
			ok: false,
			watcher,
			exitCode: 1,
			message: formatWatcherTransportError(watcher, error),
		}
	}
}

// ---------------------------------------------------------------------------
// Resolve-only helper (for streaming / loop commands)
// ---------------------------------------------------------------------------

/** Resolve a watcher or write error + candidates to output and set exitCode. Returns the watcher or `null`. */
export async function resolveWatcherOrExit(input: { id?: string }, output: Output): Promise<{ watcher: WatcherRecord } | null> {
	const resolved = await resolveWatcher(input)
	if (!resolved.ok) {
		writeResolveError(resolved, output)
		return null
	}
	return { watcher: resolved.watcher }
}

// ---------------------------------------------------------------------------
// Error output
// ---------------------------------------------------------------------------

/** Write a request error (including any watcher candidates) to output and set process.exitCode. */
export function writeRequestError(result: WatcherRequestError, output: Output): void {
	output.writeWarn(result.message)
	if (result.candidates && result.candidates.length > 0) {
		for (const watcher of result.candidates) {
			output.writeWarn(formatWatcherLine(watcher))
		}
		output.writeWarn('Hint: run `argus list` to see all watchers.')
	}
	process.exitCode = result.exitCode
}

/** Write an ErrorResponse using JSON/stdout vs human/stderr conventions. */
export function writeErrorResponse(response: ErrorResponse, output: Output): void {
	if (output.json) {
		output.writeJson(response)
	} else {
		output.writeWarn(`Error: ${response.error.message}`)
	}
	process.exitCode = 1
}

/**
 * Resolve a watcher, perform a request, and normalize transport/API errors for command handlers.
 * Returns the success payload or `null` once output/exitCode has already been handled.
 */
export async function requestWatcherAction<T extends { ok: true }>(
	input: WatcherRequestInput,
	output: Output,
): Promise<{ watcher: WatcherRecord; data: T } | null> {
	const result = await requestWatcherJson<T | ErrorResponse>({
		...input,
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

	return {
		watcher: result.watcher,
		data: result.data as T,
	}
}

/** Write resolve-watcher error output. */
function writeResolveError(resolved: { ok: false; error: string; exitCode: number; candidates?: WatcherRecord[] }, output: Output): void {
	output.writeWarn(resolved.error)
	if (resolved.candidates && resolved.candidates.length > 0) {
		for (const watcher of resolved.candidates) {
			output.writeWarn(formatWatcherLine(watcher))
		}
		output.writeWarn('Hint: run `argus list` to see all watchers.')
	}
	process.exitCode = resolved.exitCode
}
