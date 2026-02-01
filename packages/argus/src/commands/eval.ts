import type { EvalResponse } from '@vforsh/argus-core'
import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import {
	formatError,
	parseCount,
	parseIntervalMs,
	parseNumber,
	parseRetryCount,
	printError,
	printSuccess,
	resolveExpression,
	sleep,
	wrapForIframeEval,
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
	/** Read expression from stdin. Also activated when expression is `-`. */
	stdin?: boolean
	/** CSS selector for iframe to eval in via postMessage (extension mode). */
	iframe?: string
	/** Message type prefix for iframe eval (default: argus). */
	iframeNamespace?: string
	/** Timeout for iframe postMessage response in ms (default: 5000). */
	iframeTimeout?: string
}

/** Execute the eval command for a watcher id. */
export const runEval = async (id: string | undefined, rawExpression: string | undefined, options: EvalOptions): Promise<void> => {
	const output = createOutput(options)

	const resolvedExpression = await resolveExpression(rawExpression, options, output)
	if (resolvedExpression == null) {
		process.exitCode = 2
		return
	}

	let expression = resolvedExpression

	// Wrap expression for iframe eval if --iframe is provided
	if (options.iframe) {
		const iframeTimeoutMs = parseNumber(options.iframeTimeout) ?? 5000
		expression = wrapForIframeEval(expression, {
			selector: options.iframe,
			namespace: options.iframeNamespace ?? 'argus',
			timeoutMs: iframeTimeoutMs,
		})
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
			expression,
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

	let running = true
	const stop = (): void => {
		running = false
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	let iteration = 0
	while (running) {
		iteration += 1
		const iterationResult = await evalWithRetries({
			watcher,
			expression,
			awaitPromise: options.await ?? true,
			returnByValue: options.returnByValue ?? true,
			timeoutMs,
			failOnException: options.failOnException ?? true,
			retryCount: retryCount.value,
		})

		if (!iterationResult.ok) {
			printError(iterationResult, options, output)
			process.exitCode = 1
			return
		}

		printSuccess(iterationResult.response, options, output, true)

		if (untilEvaluator.evaluator) {
			const untilResult = untilEvaluator.evaluator({
				result: iterationResult.response.result,
				exception: iterationResult.response.exception ?? null,
				iteration,
				attempt: iterationResult.attempt,
			})
			if (!untilResult.ok) {
				printError({ kind: 'until', error: untilResult.error }, options, output)
				process.exitCode = 1
				return
			}
			if (untilResult.matched) {
				return
			}
		}

		if (countValue.value != null && iteration >= countValue.value) {
			return
		}

		await sleep(intervalMs.value)
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
