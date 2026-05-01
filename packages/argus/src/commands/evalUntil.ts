import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { pollEval } from './evalPolling.js'
import { parseCount, parseIntervalMs, parseNumber, parseRetryCount, prepareEvalExpression, printError, printSuccess } from './evalShared.js'

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

/** Execute the eval-until command: poll until the expression returns a truthy value. */
export const runEvalUntil = async (id: string | undefined, rawExpression: string | undefined, options: EvalUntilOptions): Promise<void> => {
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

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { watcher } = resolved
	const timeoutMs = parseNumber(options.timeout)

	const pollResult = await pollEval({
		watcher,
		expression: prepared.expression,
		args: prepared.args,
		awaitPromise: options.await ?? true,
		returnByValue: options.returnByValue ?? true,
		timeoutMs,
		failOnException: options.failOnException ?? true,
		retryCount: retryCount.value,
		intervalMs: pollIntervalMs,
		count: countValue.value,
		totalTimeoutMs: totalTimeoutMs.value,
		onResult: (response) => {
			if (!response.result && options.verbose) {
				printSuccess(response, options, output, true)
			}
		},
		shouldStop: ({ response }) => ({ ok: true, matched: Boolean(response.result) }),
	})

	if (pollResult.kind === 'matched') {
		printSuccess(pollResult.response, options, output, false)
		return
	}

	if (pollResult.kind === 'eval-error') {
		printError(pollResult.failure, options, output)
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
