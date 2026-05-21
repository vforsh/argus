import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { evalWithRetries, type EvalAttemptResult } from '../eval/evalClient.js'
import { sleep } from './evalShared.js'

type PollStopContext = {
	response: EvalResponse
	iteration: number
	attempt: number
}

type PollStopResult = { ok: true; matched: boolean } | { ok: false; error: string }

export type EvalPollInput = {
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>
	expression: string
	args?: Record<string, string>
	awaitPromise: boolean
	returnByValue: boolean
	timeoutMs?: number
	failOnException: boolean
	retryCount: number
	intervalMs: number
	count?: number
	totalTimeoutMs?: number
	shouldStop?: (context: PollStopContext) => PollStopResult
	onResult?: (response: EvalResponse, context: PollStopContext) => void | Promise<void>
}

export type EvalPollOutcome =
	| { kind: 'matched'; response: EvalResponse; iteration: number; attempt: number }
	| { kind: 'exhausted'; iterations: number }
	| { kind: 'timeout'; elapsedMs: number }
	| { kind: 'interrupted' }
	| { kind: 'eval-error'; failure: Extract<EvalAttemptResult, { ok: false }> }
	| { kind: 'condition-error'; error: string }

/** Shared polling engine for `eval --interval` and `eval-until` so loop semantics stay identical. */
export const pollEval = async (input: EvalPollInput): Promise<EvalPollOutcome> => {
	let running = true
	const stop = (): void => {
		running = false
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	try {
		const startTime = Date.now()
		let iteration = 0

		while (running) {
			if (input.totalTimeoutMs != null) {
				const elapsed = Date.now() - startTime
				if (elapsed >= input.totalTimeoutMs) {
					return { kind: 'timeout', elapsedMs: elapsed }
				}
			}

			iteration += 1
			const result = await evalWithRetries({
				watcher: input.watcher,
				expression: input.expression,
				args: input.args,
				awaitPromise: input.awaitPromise,
				returnByValue: input.returnByValue,
				timeoutMs: input.timeoutMs,
				failOnException: input.failOnException,
				retryCount: input.retryCount,
			})

			if (!result.ok) {
				return { kind: 'eval-error', failure: result }
			}

			const context = { response: result.response, iteration, attempt: result.attempt }
			// Streaming commands print the matched iteration too, so emit before checking stop conditions.
			await input.onResult?.(result.response, context)

			const stopResult = input.shouldStop?.(context)
			if (stopResult) {
				if (!stopResult.ok) {
					return { kind: 'condition-error', error: stopResult.error }
				}
				if (stopResult.matched) {
					return { kind: 'matched', response: result.response, iteration, attempt: result.attempt }
				}
			}

			if (input.count != null && iteration >= input.count) {
				return { kind: 'exhausted', iterations: iteration }
			}

			await sleep(input.intervalMs)
		}

		return { kind: 'interrupted' }
	} finally {
		process.off('SIGINT', stop)
		process.off('SIGTERM', stop)
	}
}
