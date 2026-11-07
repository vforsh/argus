import { isTruthyEvalResult, type EvalResponse } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { describeConditionReply, formatSeconds, summarizeConditionReply } from './conditionWait.js'
import { pollEval, type EvalPollOutcome } from './evalPolling.js'
import { createEvalEmitter, writeEvalSuccess } from './evalEmit.js'
import { parseDurationFlagMs, parseEvalCommonFlags, prepareEvalExpression, type EvalCommonOptions } from './evalShared.js'
import { validateEvalResultFileOptions } from './evalResultOutput.js'
import { describeSettleMiss, parseSettleFlags, settlePage, type SettleFlags } from './settle.js'

/** Options for the eval-until command. */
export type EvalUntilOptions = EvalCommonOptions &
	SettleFlags & {
	/** Give up after this much wall-clock time. */
	totalTimeout?: string
	/** Report each poll instead of only the match. */
	verbose?: boolean
}

/** Execute the eval-until command: poll until the expression returns a truthy value. */
export const runEvalUntil = async (id: string | undefined, rawExpression: string | undefined, options: EvalUntilOptions): Promise<void> => {
	const output = createOutput(options)

	if (options.settle) {
		const settled = await runSettleStep(id, options, output, rawExpression == null && !options.file && !options.stdin)
		if (settled === 'done') return
	}

	const prepared = await prepareEvalExpression(rawExpression, options, output)
	if (prepared == null) {
		process.exitCode = 2
		return
	}

	const flags = parseEvalCommonFlags(options, output)
	if (!flags) return
	const pollIntervalMs = flags.intervalMs ?? 250

	const totalTimeoutMs = parseDurationFlagMs(options.totalTimeout, '--total-timeout')
	if (totalTimeoutMs.error) {
		output.writeWarn(totalTimeoutMs.error)
		process.exitCode = 2
		return
	}

	if (!validateEvalResultFileOptions(options, output)) {
		return
	}

	const emitter = createEvalEmitter(options, output, flags.shaping)

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { watcher } = resolved

	const pollResult = await pollEval({
		watcher,
		expression: prepared.expression,
		args: prepared.args,
		awaitPromise: options.await ?? true,
		returnByValue: options.returnByValue ?? true,
		timeoutMs: flags.timeoutMs,
		// A throw is "not yet" unless `--fail-on-exception` asks otherwise: `eval-until app "appctl.ready()"`
		// runs while the app boots, when the ReferenceError is the expected answer. Matches `--until`
		// (`waitForCondition`); the miss report still names the last exception.
		failOnException: options.failOnException ?? false,
		retryCount: flags.retryCount,
		scenario: prepared.scenario,
		intervalMs: pollIntervalMs,
		count: flags.count,
		totalTimeoutMs: totalTimeoutMs.value,
		onResult: (response) => {
			if (options.verbose && !isMatch(response)) {
				writeEvalSuccess(response, options, output, true, flags.shaping)
			}
		},
		shouldStop: ({ response }) => ({ ok: true, matched: isMatch(response) }),
	})

	if (pollResult.kind === 'matched') {
		await emitter.emitSuccess(pollResult.response, false)
		return
	}

	if (pollResult.kind === 'eval-error') {
		await emitter.emitError(pollResult.failure)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'timeout' || pollResult.kind === 'exhausted') {
		writeUntilMiss(pollResult, options, output)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'condition-error') {
		if (output.json) {
			output.writeJson({ ok: false, error: { message: pollResult.error } })
		} else {
			output.writeWarn(pollResult.error)
		}
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'interrupted') {
		process.exitCode = 130
	}
}

const isMatch = (response: EvalResponse): boolean => !response.exception && isTruthyEvalResult(response)

/**
 * Report a wait that ran out, with what the expression last returned or threw.
 *
 * The bare "Total timeout exceeded" this replaces sent every caller back for a second eval just to
 * learn why; observed agent sessions lost ~45 minutes in a week to those timeouts.
 */
const writeUntilMiss = (
	outcome: Extract<EvalPollOutcome, { kind: 'timeout' } | { kind: 'exhausted' }>,
	options: EvalUntilOptions,
	output: Output,
): void => {
	const last = outcome.last ? summarizeConditionReply(outcome.last) : undefined
	const message =
		outcome.kind === 'timeout'
			? `Total timeout exceeded (${options.totalTimeout}) after ${outcome.iterations} polls`
			: `Exhausted after ${outcome.iterations} iterations (${formatSeconds(outcome.elapsedMs)}) without a truthy result`

	if (output.json) {
		output.writeJson({
			ok: false,
			error: { message, code: outcome.kind === 'timeout' ? 'wait_timeout' : 'wait_exhausted' },
			iterations: outcome.iterations,
			elapsedMs: outcome.elapsedMs,
			...(last ? { last } : {}),
		})
		return
	}
	output.writeWarn(last ? `${message}; last: ${describeConditionReply(last)}` : message)
}

/**
 * `wait --settle`: settle first, then poll the expression if there is one.
 *
 * Alone it is the whole wait, so a page that never settles fails it (`wait_timeout`); before an
 * expression it is a best-effort warm-up and a miss only warns.
 */
const runSettleStep = async (id: string | undefined, options: EvalUntilOptions, output: Output, settleOnly: boolean): Promise<'done' | 'continue'> => {
	const plan = parseSettleFlags(options, output, true)
	if (!plan) return 'done'

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return 'done'

	const outcome = await settlePage(resolved.watcher, plan, Date.now())
	if (!settleOnly) {
		if (!outcome.settled) output.writeWarn(`${describeSettleMiss(plan, outcome)}; polling anyway`)
		return 'continue'
	}

	if (!outcome.settled) process.exitCode = 1
	// `-q` mutes success only; a page that never settled still reports.
	if (outcome.settled && options.silent) return 'done'
	if (output.json) {
		output.writeJson(outcome.settled ? { ok: true, settle: outcome } : { ok: false, error: { message: describeSettleMiss(plan, outcome), code: 'wait_timeout' }, settle: outcome })
	} else if (outcome.settled) {
		output.writeHuman(`settled in ${formatSeconds(outcome.elapsedMs)} (network ${outcome.network})`)
	} else {
		output.writeWarn(describeSettleMiss(plan, outcome))
	}
	return 'done'
}
