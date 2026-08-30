import type { EvalResponse } from '@vforsh/argus-core'
import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { pollEval } from './evalPolling.js'
import { formatError } from '../cli/parse.js'
import { createEvalEmitter } from './evalEmit.js'
import { parseEvalCommonFlags, prepareEvalExpression, type EvalCommonOptions } from './evalShared.js'
import { validateEvalResultFileOptions } from './evalResultOutput.js'

/** Options for the eval command. */
export type EvalOptions = EvalCommonOptions & {
	/** Stop polling once this expression over `result` becomes truthy. Requires --interval. */
	until?: string
	/** With --interval, write one file per iteration instead of appending NDJSON. */
	rotate?: boolean
}

/** Execute the eval command for a watcher id. */
export const runEval = async (id: string | undefined, rawExpression: string | undefined, options: EvalOptions): Promise<void> => {
	const output = createOutput(options)

	const prepared = await prepareEvalExpression(rawExpression, options, output)
	if (prepared == null) {
		process.exitCode = 2
		return
	}

	const flags = parseEvalCommonFlags(options, output)
	if (!flags) return

	if (flags.count != null && flags.intervalMs == null) {
		output.writeWarn('Invalid --count usage: --count requires --interval')
		process.exitCode = 2
		return
	}

	if (options.until && flags.intervalMs == null) {
		output.writeWarn('Invalid --until usage: --until requires --interval')
		process.exitCode = 2
		return
	}

	const untilEvaluator = compileUntil(options.until)
	if (untilEvaluator.error) {
		output.writeWarn(untilEvaluator.error)
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

	if (flags.intervalMs == null) {
		const singleResult = await evalWithRetries({
			watcher,
			expression: prepared.expression,
			args: prepared.args,
			awaitPromise: options.await ?? true,
			returnByValue: options.returnByValue ?? true,
			timeoutMs: flags.timeoutMs,
			failOnException: options.failOnException ?? true,
			retryCount: flags.retryCount,
			scenario: prepared.scenario,
		})

		if (!singleResult.ok) {
			emitter.emitError(singleResult)
			process.exitCode = 1
			return
		}

		await emitter.emitSuccess(singleResult.response, false)
		return
	}

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
		intervalMs: flags.intervalMs,
		count: flags.count,
		onResult: async (response) => {
			await emitter.emitSuccess(response, true)
		},
		shouldStop: (context) => {
			if (!untilEvaluator.evaluator) {
				return { ok: true, matched: false }
			}

			const untilResult = untilEvaluator.evaluator({
				result: context.response.result,
				exception: context.response.exception ?? null,
				iteration: context.iteration,
				attempt: context.attempt,
			})

			return untilResult.ok ? { ok: true, matched: untilResult.matched } : { ok: false, error: untilResult.error }
		},
	})

	if (pollResult.kind === 'eval-error') {
		emitter.emitError(pollResult.failure)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'condition-error') {
		emitter.emitError({ kind: 'until', error: pollResult.error })
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'interrupted') {
		process.exitCode = 130
	}
}

type UntilContext = {
	result: EvalResponse['result']
	exception: EvalResponse['exception'] | null
	iteration: number
	attempt: number
}

type UntilEvaluator = (context: UntilContext) => { ok: true; matched: boolean } | { ok: false; error: string }

const compileUntil = (condition?: string): { evaluator?: UntilEvaluator; error?: string } => {
	if (condition == null) {
		return {}
	}

	const trimmed = condition.trim()
	if (!trimmed) {
		return { error: 'Invalid --until value: empty condition.' }
	}

	let compiled: (context: UntilContext) => boolean
	try {
		compiled = new Function('context', `const { result, exception, iteration, attempt } = context; return Boolean(${trimmed});`) as (
			context: UntilContext,
		) => boolean
	} catch (error) {
		return { error: `Invalid --until value: ${formatError(error)}` }
	}

	return {
		evaluator: (context) => {
			try {
				return { ok: true, matched: compiled(context) }
			} catch (error) {
				return { ok: false, error: `Failed to evaluate --until condition: ${formatError(error)}` }
			}
		},
	}
}
