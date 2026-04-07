import type { NetClearResponse, NetResponse, NetTailResponse, ReloadResponse, WatcherRecord } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { evalOnce } from '../eval/evalClient.js'
import { appendNetCommandParams, parseNetDurationMs, parseSettleDurationMs, validateNetCommandOptions } from './netShared.js'
import { parseIntervalMs } from './evalShared.js'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'

const WATCH_BATCH_LIMIT = 5_000
const DEFAULT_SETTLE_AFTER_INTERVAL_MS = 250
const SETTLE_AFTER_EVAL_TIMEOUT_MS = 5_000
const RELOAD_SELECTED_SCOPE_ERROR =
	'Cannot combine --reload with selected-frame scope. Use tab/page scope, or capture the current buffer without --reload.'

export type NetCaptureOptions = NetCliFilterOptions & {
	reload?: boolean
	clear?: boolean
	settle?: string
	settleAfter?: string
	settleAfterInterval?: string
	ignoreCache?: boolean
	maxTimeout?: string
}

type ParsedNetSettleCondition = {
	expression: string
	intervalMs: number
}

export type ParsedNetCaptureOptions = {
	settleMs: number
	maxTimeoutMs?: number
	clearBeforeCapture: boolean
	shouldReload: boolean
	ignoreCache: boolean
	settleAfter?: ParsedNetSettleCondition
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

	const settleAfter = parseNetSettleCondition(options)
	if (settleAfter.error) {
		return { error: settleAfter.error }
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
			settleAfter: settleAfter.value,
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
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
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

	return {
		cleared,
		...(capture.settleAfter
			? await waitForNetworkToConditionAndSettle(watcher, options, capture.settleMs, capture.settleAfter, capture.maxTimeoutMs)
			: await waitForNetworkToSettle(watcher, options, capture.settleMs, capture.maxTimeoutMs)),
	}
}

const waitForNetworkToSettle = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	options: NetCliFilterOptions,
	settleMs: number,
	maxTimeoutMs?: number,
): Promise<{ requests: NetResponse['requests']; timedOut: boolean }> => {
	const state = createTailState()

	while (true) {
		const remaining = getRemainingCaptureMs(state.startedAt, maxTimeoutMs)
		if (remaining != null && remaining <= 0) {
			return { requests: state.requests, timedOut: true }
		}

		const timeoutMs = remaining != null ? Math.min(settleMs, remaining) : settleMs
		const response = await pollNetTail(watcher, options, state.after, timeoutMs)

		if (response.requests.length === 0) {
			return { requests: state.requests, timedOut: maxTimeoutMs != null && timeoutMs < settleMs }
		}

		appendTailBatch(state, response)
	}
}

/**
 * `--settle-after` adds a JS readiness gate ahead of the quiet-window capture.
 * Requests are collected from the beginning, but the final quiet window only starts
 * once the condition becomes truthy, so late boot traffic still makes the cut.
 */
const waitForNetworkToConditionAndSettle = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	options: NetCliFilterOptions,
	settleMs: number,
	condition: ParsedNetSettleCondition,
	maxTimeoutMs?: number,
): Promise<{ requests: NetResponse['requests']; timedOut: boolean }> => {
	const state = createTailState()
	let conditionMatchedAt: number | null = null

	while (true) {
		const remaining = getRemainingCaptureMs(state.startedAt, maxTimeoutMs)
		if (remaining != null && remaining <= 0) {
			return { requests: state.requests, timedOut: true }
		}

		if (conditionMatchedAt == null) {
			const conditionResult = await evalOnce({
				watcher,
				expression: condition.expression,
				awaitPromise: true,
				returnByValue: true,
				timeoutMs: resolveConditionEvalTimeoutMs(remaining ?? undefined),
				failOnException: true,
			})
			if (!conditionResult.ok) {
				throw new Error(conditionResult.error)
			}
			if (conditionResult.response.result) {
				conditionMatchedAt = Date.now()
			}
		}

		const quietElapsedMs = conditionMatchedAt == null ? 0 : getConditionQuietElapsedMs(conditionMatchedAt, state.lastMatchAt)
		if (conditionMatchedAt != null && quietElapsedMs >= settleMs) {
			return { requests: state.requests, timedOut: false }
		}

		const timeoutMs =
			remaining != null
				? Math.min(getConditionPollMs(condition, settleMs, quietElapsedMs, conditionMatchedAt), remaining)
				: getConditionPollMs(condition, settleMs, quietElapsedMs, conditionMatchedAt)
		const response = await pollNetTail(watcher, options, state.after, timeoutMs)

		if (response.requests.length === 0) {
			continue
		}

		appendTailBatch(state, response)
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

const parseNetSettleCondition = (
	options: Pick<NetCaptureOptions, 'settleAfter' | 'settleAfterInterval'>,
): {
	value?: ParsedNetSettleCondition
	error?: string
} => {
	if (options.settleAfter == null) {
		if (options.settleAfterInterval != null) {
			return { error: 'Cannot use --settle-after-interval without --settle-after.' }
		}
		return {}
	}

	const expression = options.settleAfter.trim()
	if (!expression) {
		return { error: 'Invalid --settle-after value: expression is empty.' }
	}

	const interval = parseIntervalMs(options.settleAfterInterval)
	if (interval.error) {
		return { error: interval.error.replace('--interval', '--settle-after-interval') }
	}

	return {
		value: {
			expression,
			intervalMs: interval.value ?? DEFAULT_SETTLE_AFTER_INTERVAL_MS,
		},
	}
}

type NetTailState = {
	requests: NetResponse['requests']
	after: number
	lastMatchAt: number | null
	startedAt: number
}

const createTailState = (): NetTailState => ({
	requests: [],
	after: 0,
	lastMatchAt: null,
	startedAt: Date.now(),
})

const appendTailBatch = (state: NetTailState, response: NetTailResponse): void => {
	state.requests.push(...response.requests)
	state.after = response.nextAfter
	state.lastMatchAt = Date.now()
}

const pollNetTail = async (
	watcher: Pick<WatcherRecord, 'host' | 'port'>,
	options: NetCliFilterOptions,
	after: number,
	timeoutMs: number,
): Promise<NetTailResponse> =>
	await fetchWatcherJson<NetTailResponse>(watcher, {
		path: '/net/tail',
		query: createNetTailParams(options, after, timeoutMs),
		timeoutMs: timeoutMs + 5_000,
	})

const getRemainingCaptureMs = (startedAt: number, maxTimeoutMs?: number): number | null =>
	maxTimeoutMs != null ? maxTimeoutMs - (Date.now() - startedAt) : null

const getConditionPollMs = (
	condition: ParsedNetSettleCondition,
	settleMs: number,
	quietElapsedMs: number,
	conditionMatchedAt: number | null,
): number => (conditionMatchedAt == null ? condition.intervalMs : Math.max(1, settleMs - quietElapsedMs))

const resolveConditionEvalTimeoutMs = (remainingMs?: number): number | undefined => {
	if (remainingMs == null) {
		return SETTLE_AFTER_EVAL_TIMEOUT_MS
	}

	return Math.max(1, Math.min(SETTLE_AFTER_EVAL_TIMEOUT_MS, remainingMs))
}

const getConditionQuietElapsedMs = (conditionMatchedAt: number, lastMatchAt: number | null): number => {
	return Date.now() - Math.max(conditionMatchedAt, lastMatchAt ?? conditionMatchedAt)
}
