import type { ApiResult, EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'

/**
 * Evaluate an expression in the watcher's page and return its JSON value.
 *
 * Uses `jsonValue` so the CDP and extension transports return identical shapes. Throws with the
 * page exception or watcher error text; callers turn that into command output.
 */
export const evalPageJson = async <T = unknown>(watcher: WatcherRecord, expression: string, options: { timeoutMs?: number } = {}): Promise<T> => {
	const timeoutMs = options.timeoutMs ?? 10_000
	const response = await fetchWatcherJson<ApiResult<EvalResponse>>(watcher, {
		path: '/eval',
		method: 'POST',
		body: { expression, awaitPromise: true, returnByValue: true, jsonValue: true, timeoutMs },
		timeoutMs: timeoutMs + 2_000,
		returnErrorResponse: true,
	})
	if (!response.ok) throw new Error(response.error.message)
	if (response.exception) throw new Error(`page exception: ${response.exception.text}`)
	if (typeof response.result !== 'string') return response.result as T
	return (JSON.parse(response.result) as { v: T }).v
}

/** POST a JSON body to a watcher endpoint and unwrap the `ok` envelope, throwing the watcher's error text. */
export const postWatcherJson = async <T extends { ok: true }>(watcher: WatcherRecord, path: string, body: unknown, timeoutMs: number): Promise<T> => {
	const response = await fetchWatcherJson<ApiResult<T>>(watcher, { path, method: 'POST', body, timeoutMs, returnErrorResponse: true })
	if (!response.ok) throw new Error(response.error.message)
	return response
}
