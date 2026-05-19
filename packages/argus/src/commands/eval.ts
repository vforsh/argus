import type { EvalResponse } from '@vforsh/argus-core'
import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { pollEval } from './evalPolling.js'
import {
	formatError,
	parseCount,
	parseIntervalMs,
	parseNumber,
	parseRetryCount,
	prepareEvalExpression,
	printError,
	printSuccess,
} from './evalShared.js'

/** Options for the eval command. */
export type EvalOptions = {
	json?: boolean
	await?: boolean
	timeout?: string
	returnByValue?: boolean
	failOnException?: boolean
	retry?: string
	silent?: boolean
	interval?: string
	count?: string
	until?: string
	/** Read expression from a file path. */
	file?: string
	/** Bundle local imports from `--file` before eval. */
	bundle?: boolean
	/** Do not bundle `--file` (disables auto-bundle for import/export). */
	noBundle?: boolean
	/** Read expression from stdin. Also activated when expression is `-`. */
	stdin?: boolean
	/** Read setup code from a file and run it before the expression. */
	inject?: string
	/** CSS selector for iframe to eval in via postMessage (extension mode). */
	iframe?: string
	/** Message type prefix for iframe eval (default: argus). */
	iframeNamespace?: string
	/** Timeout for iframe postMessage response in ms (default: 5000). */
	iframeTimeout?: string
	/** Repeated key=value arguments exposed to scripts as `args`. */
	arg?: string[]
}

/** Execute the eval command for a watcher id. */
export const runEval = async (id: string | undefined, rawExpression: string | undefined, options: EvalOptions): Promise<void> => {
	const output = createOutput(options)

	const prepared = await prepareEvalExpression(rawExpression, options, output)
	if (prepared == null) {
		process.exitCode = 2
		return
	}

	const retryCount = parseRetryCount(options.retry)
	if (retryCount.error) {
		output.writeWarn(retryCount.error)
		process.exitCode = 2
		return
	}

	const intervalMs = parseIntervalMs(options.interval)
	if (intervalMs.error) {
		output.writeWarn(intervalMs.error)
		process.exitCode = 2
		return
	}

	const countValue = parseCount(options.count)
	if (countValue.error) {
		output.writeWarn(countValue.error)
		process.exitCode = 2
		return
	}
	if (countValue.value != null && intervalMs.value == null) {
		output.writeWarn('Invalid --count usage: --count requires --interval')
		process.exitCode = 2
		return
	}

	if (options.until && intervalMs.value == null) {
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

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { watcher } = resolved

	const timeoutMs = parseNumber(options.timeout)

	if (intervalMs.value == null) {
		const singleResult = await evalWithRetries({
			watcher,
			expression: prepared.expression,
			args: prepared.args,
			awaitPromise: options.await ?? true,
			returnByValue: options.returnByValue ?? true,
			timeoutMs,
			failOnException: options.failOnException ?? true,
			retryCount: retryCount.value,
		})

		if (!singleResult.ok) {
			printError(singleResult, options, output)
			process.exitCode = 1
			return
		}

		printSuccess(singleResult.response, options, output, false)
		return
	}

	const pollResult = await pollEval({
		watcher,
		expression: prepared.expression,
		args: prepared.args,
		awaitPromise: options.await ?? true,
		returnByValue: options.returnByValue ?? true,
		timeoutMs,
		failOnException: options.failOnException ?? true,
		retryCount: retryCount.value,
		intervalMs: intervalMs.value,
		count: countValue.value,
		onResult: (response) => {
			printSuccess(response, options, output, true)
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
		printError(pollResult.failure, options, output)
		process.exitCode = 1
		return
	}

	if (pollResult.kind === 'condition-error') {
		printError({ kind: 'until', error: pollResult.error }, options, output)
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
