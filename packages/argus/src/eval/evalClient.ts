import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'

const DEFAULT_EVAL_REQUEST_TIMEOUT_MS = 10_000
const MIN_SUGGESTED_TIMEOUT_MS = 60_000

export type EvalOnceInput = {
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>
	expression: string
	args?: Record<string, string>
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
		args: input.args,
		awaitPromise: input.awaitPromise,
		replMode: input.replMode,
		returnByValue: input.returnByValue,
		timeoutMs: input.timeoutMs,
	}
	const requestTimeoutMs = input.timeoutMs ? input.timeoutMs + 5_000 : DEFAULT_EVAL_REQUEST_TIMEOUT_MS

	let response: EvalResponse
	try {
		response = await fetchWatcherJson<EvalResponse>(input.watcher, {
			path: '/eval',
			method: 'POST',
			body,
			timeoutMs: requestTimeoutMs,
		})
	} catch (error) {
		return {
			ok: false,
			kind: 'transport',
			error: formatEvalTransportError(input.watcher, error, input.timeoutMs),
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

/** Format transport errors with an eval-specific timeout hint when a long-running script likely exceeded the request budget. */
export const formatEvalTransportError = (watcher: Pick<WatcherRecord, 'id'>, error: unknown, timeoutMs: number | undefined): string => {
	const baseMessage = formatWatcherTransportError(watcher, error)
	if (!isTimeoutError(error)) {
		return baseMessage
	}

	const suggestedTimeoutMs = Math.max(MIN_SUGGESTED_TIMEOUT_MS, (timeoutMs ?? DEFAULT_EVAL_REQUEST_TIMEOUT_MS) * 2)
	return (
		`${baseMessage}. ` +
		`Eval may need more time; pass a longer timeout as milliseconds or a duration, for example: ` +
		`\`argus eval ${watcher.id} --timeout ${formatSuggestedDuration(suggestedTimeoutMs)} ...\``
	)
}

const isTimeoutError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error)
	return /timed out|timeout/i.test(message)
}

const formatSuggestedDuration = (timeoutMs: number): string => {
	if (timeoutMs % 1_000 === 0) {
		return `${timeoutMs / 1_000}s`
	}
	return String(timeoutMs)
}

export const evalWithRetries = async (input: EvalWithRetriesInput): Promise<EvalAttemptResult> => {
	let attempt = 0
	while (attempt <= input.retryCount) {
		attempt += 1
		const outcome = await evalOnce({
			watcher: input.watcher,
			expression: input.expression,
			args: input.args,
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
