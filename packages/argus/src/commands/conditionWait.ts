import type { EvalResponse, WatcherRecord } from '@vforsh/argus-core'
import { isTruthyEvalResult } from '@vforsh/argus-core'
import { evalOnce } from '../eval/evalClient.js'
import { getRequestContext, withRequestContext } from '../session/requestContext.js'
import type { Output } from '../output/io.js'
import { describeExceptionDetails } from './evalEmit.js'
import { formatEvalValue } from './evalResultOutput.js'
import { parseDurationFlagMs } from './evalShared.js'

/**
 * Page-condition waits: the `--until <expr>` flag on action commands, and the timeout report
 * `eval-until` shares with it.
 *
 * Agents used to follow `click`/`reload`/`goto` with `sleep N` (13% of observed calls) or a
 * second `eval-until` process; this folds the wait into the action and reports what the page
 * last said when it never became true.
 */

/** What a condition last evaluated to: a value, or the exception it threw. */
export type ConditionReply = { result: unknown; type?: string } | { exception: { text: string; description?: string } }

/**
 * Reduce an eval reply to the part worth reporting: no CDP object ids.
 *
 * `type` stays because `undefined`/`NaN` arrive as the strings "undefined"/"NaN"; without it a
 * JSON reader cannot tell them from a page that returned that text.
 */
export const summarizeConditionReply = (response: EvalResponse): ConditionReply => {
	if (response.exception) {
		const description = describeExceptionDetails(response.exception.details)
		return { exception: description ? { text: response.exception.text, description } : { text: response.exception.text } }
	}
	return response.type ? { result: response.result, type: response.type } : { result: response.result }
}

/** One-line human preview of a condition reply, bounded so a large object cannot flood stderr. */
export const describeConditionReply = (reply: ConditionReply): string => {
	if ('exception' in reply) {
		return `threw ${reply.exception.description?.split('\n')[0] ?? reply.exception.text}`
	}
	const value = formatEvalValue(reply.result)
	return value.length > 200 ? `${value.slice(0, 200)}…` : value
}

/** Options every action command with `--until` accepts. */
export type UntilFlags = {
	until?: string
	untilTimeout?: string
}

/** A validated `--until` request. */
export type UntilPlan = {
	expression: string
	timeoutMs: number
}

const DEFAULT_UNTIL_TIMEOUT_MS = 15_000
const UNTIL_INTERVAL_MS = 250
/** Per-poll page budget: long enough for an `await`ed check, short enough to keep polling. */
const UNTIL_EVAL_TIMEOUT_MS = 5_000

/**
 * Validate `--until`/`--until-timeout` before the action runs.
 *
 * Returns `undefined` when no condition was asked for and `null` after reporting a usage error;
 * a bad duration must not surface only after the click it was meant to follow.
 */
export const parseUntilFlags = (options: UntilFlags, output: Output): UntilPlan | undefined | null => {
	if (options.until == null) {
		if (options.untilTimeout != null) {
			output.writeWarn('--until-timeout requires --until <expression>.')
			process.exitCode = 2
			return null
		}
		return undefined
	}

	const expression = options.until.trim()
	if (!expression) {
		output.writeWarn('--until requires a JS expression.')
		process.exitCode = 2
		return null
	}

	const timeout = parseDurationFlagMs(options.untilTimeout, '--until-timeout')
	if (timeout.error) {
		output.writeWarn(timeout.error)
		process.exitCode = 2
		return null
	}

	return { expression, timeoutMs: timeout.value ?? DEFAULT_UNTIL_TIMEOUT_MS }
}

/**
 * Where the last poll of a missed wait got stuck, so a reader knows which layer to fix:
 * the selected iframe never came back (`target_missing`), it came back but never got an execution
 * context (`target_not_ready`), the condition ran and was falsy or threw, or the request failed.
 */
export type UntilLastState = 'target_missing' | 'target_not_ready' | 'falsy' | 'threw' | 'error'

/** Result of a post-action wait, shaped for the command's JSON output. */
export type UntilOutcome =
	| { matched: true; value: unknown; iterations: number; elapsedMs: number }
	| {
			matched: false
			iterations: number
			elapsedMs: number
			/** Absent when no poll got an answer before the deadline. */
			lastState?: UntilLastState
			last?: ConditionReply
			lastError?: string
			/** Set when the caller's own deadline or cancellation (an `argus session` request) ended the wait first. */
			stoppedBy?: 'request'
	  }

/**
 * Poll `plan.expression` until it is truthy or the budget runs out.
 *
 * Exceptions and transport failures count as "not yet": right after `reload`/`goto` the app's
 * globals are missing and the target may be swapping, which is exactly when callers wait. A
 * selected iframe that is missing or still booting (`extension_frame_missing`/`_not_ready`) is the
 * same "not yet": the watcher keeps the selection and each poll waits inside the re-resolved frame.
 */
export const waitForCondition = async (watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>, plan: UntilPlan): Promise<UntilOutcome> => {
	const startedAt = Date.now()
	// `--until-timeout` is a hard deadline, and an `argus session` request's own deadline or
	// cancellation ends the wait too — otherwise an abandoned request kept polling for its full
	// budget after the session had already answered it.
	const parent = getRequestContext()
	const deadline = Math.min(startedAt + plan.timeoutMs, parent.deadline ?? Infinity)
	const scope = { deadline, signal: parent.signal }
	let iterations = 0
	let last: ConditionReply | undefined
	let lastError: string | undefined
	let lastState: UntilLastState | undefined

	while (Date.now() < deadline && !parent.signal?.aborted) {
		iterations += 1
		// The scoped deadline bounds the whole poll (HTTP wait and page-side budget alike).
		const outcome = await withRequestContext(scope, () =>
			evalOnce({
				watcher,
				expression: plan.expression,
				awaitPromise: true,
				returnByValue: true,
				timeoutMs: Math.max(1, Math.min(UNTIL_EVAL_TIMEOUT_MS, deadline - Date.now())),
				failOnException: false,
			}),
		)
		// A reply after the deadline does not count, and a poll cut short by the deadline is not an
		// error worth reporting over the last real reply.
		if (Date.now() > deadline) break

		if (outcome.ok) {
			if (!outcome.response.exception && isTruthyEvalResult(outcome.response)) {
				return { matched: true, value: outcome.response.result, iterations, elapsedMs: Date.now() - startedAt }
			}
			last = summarizeConditionReply(outcome.response)
			lastError = undefined
			lastState = 'exception' in last ? 'threw' : 'falsy'
		} else {
			lastError = outcome.error
			lastState = classifyEvalFailure(outcome.code)
		}

		await sleepUntil(Math.min(Date.now() + UNTIL_INTERVAL_MS, deadline), parent.signal)
	}

	const cutByRequest = Boolean(parent.signal?.aborted) || (deadline === parent.deadline && Date.now() >= deadline)
	return {
		matched: false,
		iterations,
		elapsedMs: Date.now() - startedAt,
		...(cutByRequest ? { stoppedBy: 'request' as const } : {}),
		...(lastState ? { lastState } : {}),
		...(last ? { last } : {}),
		...(lastError ? { lastError } : {}),
	}
}

const classifyEvalFailure = (code: string | undefined): UntilLastState => {
	if (code === 'extension_frame_missing') return 'target_missing'
	if (code === 'extension_frame_not_ready') return 'target_not_ready'
	return 'error'
}

/** Resolve at `until` (epoch ms), or as soon as `signal` aborts. */
const sleepUntil = (until: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve()
		const finish = (): void => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			resolve()
		}
		const timer = setTimeout(finish, Math.max(0, until - Date.now()))
		signal?.addEventListener('abort', finish, { once: true })
	})

/** Human line for a missed post-action condition. */
export const describeUntilMiss = (plan: UntilPlan, outcome: Extract<UntilOutcome, { matched: false }>): string => {
	const budget = outcome.stoppedBy === 'request' ? `before the request deadline (${formatSeconds(outcome.elapsedMs)})` : `within ${formatSeconds(plan.timeoutMs)}`
	return `--until not met ${budget} (${outcome.iterations} polls); ${describeLastReply(outcome)}`
}

const describeLastReply = (outcome: Extract<UntilOutcome, { matched: false }>): string => {
	if (outcome.lastState === 'target_missing') return `selected iframe never came back: ${outcome.lastError}`
	if (outcome.lastState === 'target_not_ready') return `selected iframe never became executable: ${outcome.lastError}`
	if (outcome.lastError) return `last error: ${outcome.lastError}`
	if (outcome.last) return `last: ${describeConditionReply(outcome.last)}`
	return 'no reply'
}

/** Compact duration for status lines: `850ms`, `2.5s`, `30s`. */
export const formatSeconds = (ms: number): string => {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.round(ms / 1000)}s`
}
