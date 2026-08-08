import type { EvalPollOutcome as CoreEvalPollOutcome } from '@vforsh/argus-client'
import { pollEval as pollEvalCore } from '@vforsh/argus-client'
import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { evalWithRetries, type EvalAttemptResult } from '../eval/evalClient.js'

/** A failed eval attempt, after retries were exhausted. */
type EvalFailure = Extract<EvalAttemptResult, { ok: false }>

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
	scenario?: boolean
	intervalMs: number
	count?: number
	totalTimeoutMs?: number
	shouldStop?: (context: PollStopContext) => PollStopResult
	onResult?: (response: EvalResponse, context: PollStopContext) => void | Promise<void>
}

export type EvalPollOutcome = CoreEvalPollOutcome<EvalResponse, EvalFailure>

/**
 * CLI adapter over the shared polling engine in `@vforsh/argus-client`, so
 * `eval --interval` and `eval-until` keep identical loop semantics to the SDK.
 *
 * The shared core deliberately installs no process listeners; CLI-only concerns —
 * SIGINT/SIGTERM handling and the retry policy — are wired in here.
 */
export const pollEval = async (input: EvalPollInput): Promise<EvalPollOutcome> => {
	const controller = new AbortController()
	const abort = (): void => controller.abort()

	process.on('SIGINT', abort)
	process.on('SIGTERM', abort)

	try {
		return await pollEvalCore<EvalResponse, EvalFailure>({
			intervalMs: input.intervalMs,
			count: input.count,
			totalTimeoutMs: input.totalTimeoutMs,
			signal: controller.signal,
			shouldStop: input.shouldStop,
			onResult: input.onResult,
			runEval: async () => {
				const result = await evalWithRetries({
					watcher: input.watcher,
					expression: input.expression,
					args: input.args,
					awaitPromise: input.awaitPromise,
					returnByValue: input.returnByValue,
					timeoutMs: input.timeoutMs,
					failOnException: input.failOnException,
					retryCount: input.retryCount,
					scenario: input.scenario,
				})

				if (!result.ok) {
					return { ok: false, failure: result, attempt: result.attempt }
				}

				return { ok: true, response: result.response, attempt: result.attempt }
			},
		})
	} finally {
		process.off('SIGINT', abort)
		process.off('SIGTERM', abort)
	}
}
