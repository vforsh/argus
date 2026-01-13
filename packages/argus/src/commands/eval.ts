import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { parseDurationMs } from '../time.js'

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
export const runEval = async (id: string, expression: string, options: EvalOptions): Promise<void> => {
	if (!expression || expression.trim() === '') {
		console.error('Expression is required')
		process.exitCode = 2
		return
	}

	const retryCount = parseRetryCount(options.retry)
	if (retryCount.error) {
		console.error(retryCount.error)
		process.exitCode = 2
		return
	}

	const intervalMs = parseIntervalMs(options.interval)
	if (intervalMs.error) {
		console.error(intervalMs.error)
		process.exitCode = 2
		return
	}

	const countValue = parseCount(options.count)
	if (countValue.error) {
		console.error(countValue.error)
		process.exitCode = 2
		return
	}
	if (countValue.value != null && intervalMs.value == null) {
		console.error('Invalid --count usage: --count requires --interval')
		process.exitCode = 2
		return
	}

	if (options.until && intervalMs.value == null) {
		console.error('Invalid --until usage: --until requires --interval')
		process.exitCode = 2
		return
	}

	const untilEvaluator = compileUntil(options.until)
	if (untilEvaluator.error) {
		console.error(untilEvaluator.error)
		process.exitCode = 2
		return
	}

	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

	const timeoutMs = parseNumber(options.timeout)

	if (intervalMs.value == null) {
		const singleResult = await evalWithRetries({
			watcher,
			expression,
			awaitPromise: options.await ?? true,
			returnByValue: options.returnByValue ?? true,
			timeoutMs,
			failOnException: options.failOnException ?? false,
			retryCount: retryCount.value,
		})

		if (!singleResult.ok) {
			if (singleResult.kind === 'transport') {
				registry = await removeWatcherAndPersist(registry, watcher.id)
			}
			printError(singleResult, options)
			process.exitCode = 1
			return
		}

		printSuccess(singleResult.response, options)
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
			failOnException: options.failOnException ?? false,
			retryCount: retryCount.value,
		})

		if (!iterationResult.ok) {
			if (iterationResult.kind === 'transport') {
				registry = await removeWatcherAndPersist(registry, watcher.id)
			}
			printError(iterationResult, options)
			process.exitCode = 1
			return
		}

		printSuccess(iterationResult.response, options)

		if (untilEvaluator.evaluator) {
			const untilResult = untilEvaluator.evaluator({
				result: iterationResult.response.result,
				exception: iterationResult.response.exception ?? null,
				iteration,
				attempt: iterationResult.attempt,
			})
			if (!untilResult.ok) {
				printError({ kind: 'until', error: untilResult.error }, options)
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
		compiled = new Function(
			'context',
			`const { result, exception, iteration, attempt } = context; return Boolean(${trimmed});`,
		) as (context: UntilContext) => boolean
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

type EvalAttemptInput = {
	watcher: { id: string; host: string; port: number }
	expression: string
	awaitPromise: boolean
	returnByValue: boolean
	timeoutMs?: number
	failOnException: boolean
	retryCount: number
}

type EvalAttemptSuccess = {
	ok: true
	response: EvalResponse
	attempt: number
}

type EvalAttemptFailure = {
	ok: false
	kind: 'transport' | 'exception'
	error: string
	response?: EvalResponse
	attempt: number
}

type EvalAttemptResult = EvalAttemptSuccess | EvalAttemptFailure

type EvalAttemptOutcome =
	| { ok: true; response: EvalResponse }
	| { ok: false; kind: 'transport' | 'exception'; error: string; response?: EvalResponse }

const evalWithRetries = async (input: EvalAttemptInput): Promise<EvalAttemptResult> => {
	let attempt = 0
	while (attempt <= input.retryCount) {
		attempt += 1
		const outcome = await evalOnce({
			watcher: input.watcher,
			expression: input.expression,
			awaitPromise: input.awaitPromise,
			returnByValue: input.returnByValue,
			timeoutMs: input.timeoutMs,
			failOnException: input.failOnException,
		})

		if (outcome.ok) {
			return { ...outcome, attempt }
		}

		const canRetry = attempt <= input.retryCount
		if (!canRetry) {
			return { ...outcome, attempt }
		}
	}

	return {
		ok: false,
		kind: 'transport',
		error: `${input.watcher.id}: failed to reach watcher (unknown error)`,
		attempt,
	}
}

const evalOnce = async (input: Omit<EvalAttemptInput, 'retryCount'>): Promise<EvalAttemptOutcome> => {
	const url = `http://${input.watcher.host}:${input.watcher.port}/eval`
	let response: EvalResponse
	try {
		response = await fetchJson<EvalResponse>(url, {
			method: 'POST',
			body: {
				expression: input.expression,
				awaitPromise: input.awaitPromise,
				returnByValue: input.returnByValue,
				timeoutMs: input.timeoutMs,
			},
			timeoutMs: input.timeoutMs ? input.timeoutMs + 5_000 : 10_000,
		})
	} catch (error) {
		return {
			ok: false,
			kind: 'transport',
			error: `${input.watcher.id}: failed to reach watcher (${formatError(error)})`,
		}
	}

	if (response.exception && input.failOnException) {
		return {
			ok: false,
			kind: 'exception',
			response,
			error: formatExceptionMessage(response),
		}
	}

	return { ok: true, response }
}

const printSuccess = (response: EvalResponse, options: EvalOptions): void => {
	if (options.silent) {
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response))
		return
	}

	if (response.exception) {
		writeException(process.stdout, response)
		return
	}

	process.stdout.write(`${previewStringify(response.result)}\n`)
}

const printError = (error: EvalAttemptFailure | { kind: 'until'; error: string }, options: EvalOptions): void => {
	if (options.json && 'response' in error && error.response) {
		process.stdout.write(JSON.stringify(error.response))
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		writeException(process.stderr, error.response)
		return
	}

	process.stderr.write(`${error.error}\n`)
}

const formatExceptionMessage = (response: EvalResponse): string => {
	if (!response.exception) {
		return 'Exception: unknown error'
	}
	return `Exception: ${response.exception.text}`
}

const writeException = (stream: NodeJS.WriteStream, response: EvalResponse): void => {
	if (!response.exception) {
		return
	}
	stream.write(`Exception: ${response.exception.text}\n`)
	if (response.exception.details) {
		stream.write(`${previewStringify(response.exception.details)}\n`)
	}
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
