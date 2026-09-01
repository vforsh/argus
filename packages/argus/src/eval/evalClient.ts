import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { classifyWatcherFailure } from '@vforsh/argus-core'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'
import { formatError } from '../cli/parse.js'

/** Page-side deadline used when `--timeout` is absent. */
const DEFAULT_EVAL_TIMEOUT_MS = 10_000
/**
 * Headroom over the page deadline, so the watcher's own answer wins the race against the HTTP
 * timeout. Sized for the layered diagnosis the watcher runs after a stall — two short probes plus
 * the reply — because a diagnosis that arrives after the client has given up explains nothing.
 */
const REQUEST_TIMEOUT_GRACE_MS = 8_000
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
	scenario?: boolean
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
	// Always name the page-side deadline. The watcher can say *which layer* stalled — dead browser,
	// replaced target, wedged renderer, slow expression — but only if it is the side that gives up
	// first; letting the HTTP request expire instead throws that diagnosis away.
	const evalTimeoutMs = input.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS
	const body = {
		expression: input.expression,
		args: input.args,
		awaitPromise: input.awaitPromise,
		replMode: input.replMode,
		returnByValue: input.returnByValue,
		timeoutMs: evalTimeoutMs,
		scenario: input.scenario,
	}
	const requestTimeoutMs = evalTimeoutMs + REQUEST_TIMEOUT_GRACE_MS

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

/**
 * Explain a transport failure that never reached the watcher's own diagnosis.
 *
 * The watcher deadlines its page work and answers with the layer that stalled, so a timeout *here*
 * means something coarser: the watcher process itself did not reply. Suggesting a longer eval
 * timeout as the sole remedy — which is what this used to do for every timeout — sends the caller
 * to retune a knob that cannot help when the watcher is wedged or gone. Name that possibility
 * first, then the timeout.
 */
export const formatEvalTransportError = (watcher: Pick<WatcherRecord, 'id'>, error: unknown, timeoutMs: number | undefined): string => {
	const baseMessage = formatWatcherTransportError(watcher, error)
	// A rejection *is* the watcher's answer, and it already names the layer that stalled. Appending
	// "the watcher did not answer" on top of it would contradict the sentence before it.
	if (classifyWatcherFailure(error) === 'api-rejection' || !isTimeoutError(error)) {
		return baseMessage
	}

	const suggestedTimeoutMs = Math.max(MIN_SUGGESTED_TIMEOUT_MS, (timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS) * 2)
	return (
		`${baseMessage}. ` +
		`The watcher did not answer at all, so it may be unresponsive rather than slow: check \`argus watcher status ${watcher.id}\` ` +
		`and \`argus doctor\`. If the watcher is healthy, the expression needs more time; pass a longer timeout as milliseconds or a ` +
		`duration, for example: \`argus eval ${watcher.id} --timeout ${formatSuggestedDuration(suggestedTimeoutMs)} ...\``
	)
}

const isTimeoutError = (error: unknown): boolean => {
	const message = formatError(error)
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
			scenario: input.scenario,
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
