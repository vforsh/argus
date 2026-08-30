import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { pollEval } from './evalPolling.js'
import {
	createEvalEmitter,
	parseDurationFlagMs,
	parseEvalCommonFlags,
	prepareEvalExpression,
	printSuccess,
	type EvalCommonOptions,
} from './evalShared.js'
import { validateEvalResultFileOptions } from './evalResultOutput.js'

/** Options for the eval-until command. */
export type EvalUntilOptions = EvalCommonOptions & {
	/** Give up after this much wall-clock time. */
	totalTimeout?: string
	/** Report each poll instead of only the match. */
	verbose?: boolean
}

/** Execute the eval-until command: poll until the expression returns a truthy value. */
export const runEvalUntil = async (id: string | undefined, rawExpression: string | undefined, options: EvalUntilOptions): Promise<void> => {
	const output = createOutput(options)

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

	const emitter = createEvalEmitter(options, output)

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
		failOnException: options.failOnException ?? true,
		retryCount: flags.retryCount,
		scenario: prepared.scenario,
		intervalMs: pollIntervalMs,
		count: flags.count,
		totalTimeoutMs: totalTimeoutMs.value,
		onResult: (response) => {
			if (!response.result && options.verbose) {
				printSuccess(response, options, output, true)
			}
		},
		shouldStop: ({ response }) => ({ ok: true, matched: Boolean(response.result) }),
	})

	if (pollResult.kind === 'matched') {
		await emitter.emitSuccess(pollResult.response, false)
		return
	}

	if (pollResult.kind === 'eval-error') {
		emitter.emitError(pollResult.failure)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'timeout') {
		output.writeWarn(`Total timeout exceeded (${options.totalTimeout})`)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'exhausted') {
		output.writeWarn(`Exhausted after ${pollResult.iterations} iterations without a truthy result`)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'condition-error') {
		output.writeWarn(pollResult.error)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'interrupted') {
		process.exitCode = 130
	}
}
