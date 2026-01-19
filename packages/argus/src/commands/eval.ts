import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

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
}

/** Execute the eval command for a watcher id. */
export const runEval = async (id: string | undefined, expression: string, options: EvalOptions): Promise<void> => {
	const output = createOutput(options)
	if (!expression || expression.trim() === '') {
		output.writeWarn('Expression is required')
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

const parseNumber = (value?: string): number | undefined => {
	if (!value) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return undefined
	}

	return parsed
}

const parseRetryCount = (value?: string): { value: number; error?: string } => {
	if (value == null) {
		return { value: 0 }
	}

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) {
		return { value: 0, error: 'Invalid --retry value: expected a non-negative integer.' }
	}

	return { value: parsed }
}

const parseIntervalMs = (value?: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return { error: 'Invalid --interval value: empty duration.' }
	}

	let parsed: number | null
	if (/^[0-9]+$/.test(trimmed)) {
		parsed = Number(trimmed)
	} else {
		parsed = parseDurationMs(trimmed)
	}

	if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) {
		return { error: 'Invalid --interval value: expected milliseconds or a duration like 250ms, 3s, 2m.' }
	}

	return { value: parsed }
}

const parseCount = (value?: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return { error: 'Invalid --count value: expected a positive integer.' }
	}

	return { value: parsed }
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

type EvalAttemptFailure = {
	ok: false
	kind: 'transport' | 'exception'
	error: string
	response?: EvalResponse
	attempt: number
}

const printSuccess = (response: EvalResponse, options: EvalOptions, output: ReturnType<typeof createOutput>, streaming: boolean): void => {
	if (options.silent) {
		return
	}

	if (options.json) {
		if (streaming) {
			output.writeJsonLine(response)
		} else {
			output.writeJson(response)
		}
		return
	}

	if (response.exception) {
		output.writeHuman(formatException(response))
		return
	}

	output.writeHuman(previewStringify(response.result))
}

const printError = (
	error: EvalAttemptFailure | { kind: 'until'; error: string },
	options: EvalOptions,
	output: ReturnType<typeof createOutput>,
): void => {
	if (options.json && 'response' in error && error.response) {
		output.writeJsonLine(error.response)
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		output.writeWarn(formatException(error.response))
		return
	}

	output.writeWarn(error.error)
}

const formatException = (response: EvalResponse): string => {
	if (!response.exception) {
		return ''
	}
	if (response.exception.details) {
		return `Exception: ${response.exception.text}\n${previewStringify(response.exception.details)}`
	}
	return `Exception: ${response.exception.text}`
}

const sleep = async (durationMs: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, durationMs))
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
