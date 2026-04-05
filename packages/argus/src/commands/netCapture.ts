import type { NetClearResponse, NetResponse, NetTailResponse, ReloadResponse } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { appendNetCommandParams, parseNetDurationMs, parseSettleDurationMs, validateNetCommandOptions } from './netShared.js'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'

const WATCH_BATCH_LIMIT = 5_000
const RELOAD_SELECTED_SCOPE_ERROR =
	'Cannot combine --reload with selected-frame scope. Use tab/page scope, or capture the current buffer without --reload.'

export type NetCaptureOptions = NetCliFilterOptions & {
	reload?: boolean
	clear?: boolean
	settle?: string
	ignoreCache?: boolean
	maxTimeout?: string
}

export type ParsedNetCaptureOptions = {
	settleMs: number
	maxTimeoutMs?: number
	clearBeforeCapture: boolean
	shouldReload: boolean
	ignoreCache: boolean
}

/**
 * Parse capture options shared by `net watch` and `net export`.
 * `defaultClear` lets each command keep its own sane default without forking validation logic.
 */
export const parseNetCaptureOptions = (
	options: NetCaptureOptions,
	config: { defaultClear: boolean },
): { value?: ParsedNetCaptureOptions; error?: string } => {
	const reloadScope = validateReloadScope(options)
	if (reloadScope.error) {
		return reloadScope
	}

	const settle = parseSettleDurationMs(options.settle)
	if (settle.error || settle.value == null) {
		return { error: settle.error ?? 'Invalid --settle value.' }
	}

	const maxTimeout = parseNetDurationMs(options.maxTimeout, '--max-timeout')
	if (maxTimeout.error) {
		return { error: maxTimeout.error }
	}

	const validation = validateNetCommandOptions(options)
	if (validation.error) {
		return { error: validation.error }
	}

	return {
		value: {
			settleMs: settle.value,
			maxTimeoutMs: maxTimeout.value,
			clearBeforeCapture: options.clear ?? config.defaultClear,
			shouldReload: options.reload === true,
			ignoreCache: options.ignoreCache === true,
		},
	}
}

/**
 * Reload capture is only supported for stable page/tab scopes.
 * Selected-frame scope is intentionally rejected because iframe rematch across reload
 * is not reliable enough to promise correct watch/export output.
 */
const validateReloadScope = (options: NetCaptureOptions): { error?: string } => {
	if (!options.reload) {
		return {}
	}

	if (options.scope === 'selected' || options.frame === 'selected') {
		return { error: RELOAD_SELECTED_SCOPE_ERROR }
	}

	return {}
}

/** Clear/reload if requested, then tail matching requests until the quiet window is reached. */
export const captureNetWindow = async (
	watcher: { host: string; port: number },
	options: NetCliFilterOptions,
	capture: ParsedNetCaptureOptions,
): Promise<{ cleared: number; requests: NetResponse['requests']; timedOut: boolean }> => {
	let cleared = 0

	if (capture.clearBeforeCapture) {
		const response = await fetchWatcherJson<NetClearResponse>(watcher, {
			path: '/net/clear',
			method: 'POST',
			timeoutMs: 5_000,
		})
		cleared = response.cleared
	}

	if (capture.shouldReload) {
		await fetchWatcherJson<ReloadResponse>(watcher, {
			path: '/reload',
			method: 'POST',
			body: { ignoreCache: capture.ignoreCache },
			timeoutMs: 10_000,
		})
	}

	const settled = await waitForNetworkToSettle(watcher, options, capture.settleMs, capture.maxTimeoutMs)
	return { cleared, requests: settled.requests, timedOut: settled.timedOut }
}

const waitForNetworkToSettle = async (
	watcher: { host: string; port: number },
	options: NetCliFilterOptions,
	settleMs: number,
	maxTimeoutMs?: number,
): Promise<{ requests: NetResponse['requests']; timedOut: boolean }> => {
	const requests: NetResponse['requests'] = []
	let after = 0
	const startedAt = Date.now()

	while (true) {
		const remaining = maxTimeoutMs != null ? maxTimeoutMs - (Date.now() - startedAt) : null
		if (remaining != null && remaining <= 0) {
			return { requests, timedOut: true }
		}

		const timeoutMs = remaining != null ? Math.min(settleMs, remaining) : settleMs
		const response = await fetchWatcherJson<NetTailResponse>(watcher, {
			path: '/net/tail',
			query: createNetTailParams(options, after, timeoutMs),
			timeoutMs: timeoutMs + 5_000,
		})

		if (response.requests.length === 0) {
			return { requests, timedOut: maxTimeoutMs != null && timeoutMs < settleMs }
		}

		requests.push(...response.requests)
		after = response.nextAfter
	}
}

const createNetTailParams = (options: NetCliFilterOptions, after: number, timeoutMs: number): URLSearchParams => {
	const params = new URLSearchParams()
	params.set('after', String(after))
	params.set('limit', String(WATCH_BATCH_LIMIT))
	params.set('timeoutMs', String(timeoutMs))

	const query = appendNetCommandParams(params, { ...options, after: String(after), limit: String(WATCH_BATCH_LIMIT) }, { includeAfter: false })
	if (query.error) {
		throw new Error(query.error)
	}

	return params
}
