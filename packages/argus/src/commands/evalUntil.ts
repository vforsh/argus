import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'
import {
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

/** Options for the eval-until command. */
export type EvalUntilOptions = {
	json?: boolean
	await?: boolean
	timeout?: string
	returnByValue?: boolean
	failOnException?: boolean
	retry?: string
	silent?: boolean
	interval?: string
	count?: string
	totalTimeout?: string
	verbose?: boolean
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

/** Execute the eval-until command: poll until the expression returns a truthy value. */
export const runEvalUntil = async (id: string | undefined, rawExpression: string | undefined, options: EvalUntilOptions): Promise<void> => {
	const output = createOutput(options)

	const resolvedExpression = await resolveExpression(rawExpression, options, output)
	if (resolvedExpression == null) {
		process.exitCode = 2
		return
	}

	let expression = resolvedExpression

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
	const pollIntervalMs = intervalMs.value ?? 250

	const countValue = parseCount(options.count)
	if (countValue.error) {
		output.writeWarn(countValue.error)
		process.exitCode = 2
		return
	}

	const totalTimeoutMs = parseTotalTimeout(options.totalTimeout)
	if (totalTimeoutMs.error) {
		output.writeWarn(totalTimeoutMs.error)
		process.exitCode = 2
		return
	}

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved
	const timeoutMs = parseNumber(options.timeout)

	let running = true
	let interrupted = false
	const stop = (): void => {
		running = false
		interrupted = true
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	const startTime = Date.now()
	let iteration = 0

	while (running) {
		// Check total timeout before evaluating
		if (totalTimeoutMs.value != null) {
			const elapsed = Date.now() - startTime
			if (elapsed >= totalTimeoutMs.value) {
				output.writeWarn(`Total timeout exceeded (${options.totalTimeout})`)
				process.exitCode = 1
				return
			}
		}

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

		const isTruthy = Boolean(iterationResult.response.result)

		if (isTruthy) {
			printSuccess(iterationResult.response, options, output, false)
			return
		}

		if (options.verbose) {
			printSuccess(iterationResult.response, options, output, true)
		}

		// Check count limit after evaluating
		if (countValue.value != null && iteration >= countValue.value) {
			output.writeWarn(`Exhausted after ${iteration} iterations without a truthy result`)
			process.exitCode = 1
			return
		}

		await sleep(pollIntervalMs)
	}

	if (interrupted) {
		process.exitCode = 130
	}
}

const parseTotalTimeout = (value?: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return { error: 'Invalid --total-timeout value: empty duration.' }
	}

	let parsed: number | null
	if (/^[0-9]+$/.test(trimmed)) {
		parsed = Number(trimmed)
	} else {
		parsed = parseDurationMs(trimmed)
	}

	if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) {
		return { error: 'Invalid --total-timeout value: expected milliseconds or a duration like 30s, 2m, 1h.' }
	}

	return { value: parsed }
}
