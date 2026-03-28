import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'

export type EvalOnceInput = {
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>
	expression: string
	awaitPromise: boolean
	replMode?: boolean
	returnByValue: boolean
	timeoutMs?: number
	failOnException: boolean
}

export type EvalWithRetriesInput = EvalOnceInput & {
	retryCount: number
}

export type EvalOutcome =
	| { ok: true; response: EvalResponse }
	| { ok: false; kind: 'transport' | 'exception'; error: string; response?: EvalResponse }

export type EvalAttemptResult =
	| { ok: true; response: EvalResponse; attempt: number }
	| { ok: false; kind: 'transport' | 'exception'; error: string; response?: EvalResponse; attempt: number }

export const evalOnce = async (input: EvalOnceInput): Promise<EvalOutcome> => {
	const body = {
		expression: input.expression,
		awaitPromise: input.awaitPromise,
		replMode: input.replMode,
		returnByValue: input.returnByValue,
		timeoutMs: input.timeoutMs,
	}

	let response: EvalResponse
	try {
		response = await fetchWatcherJson<EvalResponse>(input.watcher, {
			path: '/eval',
			method: 'POST',
			body,
			timeoutMs: input.timeoutMs ? input.timeoutMs + 5_000 : 10_000,
		})
	} catch (error) {
		return {
			ok: false,
			kind: 'transport',
			error: formatWatcherTransportError(input.watcher, error),
		}
	}

	if (response.exception && input.failOnException) {
		return {
			ok: false,
			kind: 'exception',
			response,
			error: `Exception: ${response.exception.text}`,
		}
	}

	return { ok: true, response }
}

export const evalWithRetries = async (input: EvalWithRetriesInput): Promise<EvalAttemptResult> => {
	let attempt = 0
	while (attempt <= input.retryCount) {
		attempt += 1
		const outcome = await evalOnce({
			watcher: input.watcher,
			expression: input.expression,
			awaitPromise: input.awaitPromise,
			replMode: input.replMode,
			returnByValue: input.returnByValue,
			timeoutMs: input.timeoutMs,
			failOnException: input.failOnException,
		})

		if (outcome.ok) {
			return { ...outcome, attempt }
		}

		const canRetry = attempt <= input.retryCount
		if (!canRetry) {
			return { ...outcome, attempt }
		}
	}

	return {
		ok: false,
		kind: 'transport',
		error: formatWatcherTransportError(input.watcher, 'unknown error'),
		attempt,
	}
}
