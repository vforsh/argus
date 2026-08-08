import type { EvalResponse } from '@vforsh/argus-core'
import type { EvalOptions, EvalResult, EvalUntilOptions, EvalUntilResult, EvalValueOptions } from '../../types.js'
import { ArgusEvalError } from '../../eval/ArgusEvalError.js'
import { pollEval } from '../../eval/pollEval.js'
import type { ClientContext } from '../context.js'
import { requestWatcher } from '../watcherRequest.js'

/** Default poll spacing for `evalUntil`, matching the CLI's `--interval` default. */
const DEFAULT_POLL_INTERVAL_MS = 250

/** Default `evalUntil` budget. Callers polling for slow boot flows should raise this. */
const DEFAULT_POLL_TIMEOUT_MS = 30_000

/** Page evaluation methods: raw envelope, unwrapped value, and polling. */
export const createEvalMethods = (ctx: ClientContext) => {
	const runEval = async (watcherId: string, options: EvalOptions): Promise<EvalResult> => {
		if (!options?.expression || options.expression.trim() === '') {
			throw new Error('expression is required')
		}

		const { data: response } = await requestWatcher<EvalResponse>(ctx, watcherId, {
			path: '/eval',
			timeoutMs: options.timeoutMs ?? ctx.requestTimeoutMs,
			method: 'POST',
			body: options,
		})

		return { result: response.result, type: response.type, exception: response.exception }
	}

	const evalValue = async <T = unknown>(watcherId: string, expression: string, options: EvalValueOptions = {}): Promise<T> => {
		if (!expression || expression.trim() === '') {
			throw new Error('expression is required')
		}

		const useJsonValue = options.jsonValue ?? true

		const result = await runEval(watcherId, {
			...options,
			expression,
			returnByValue: true,
			jsonValue: useJsonValue,
		})

		if (result.exception) {
			throw ArgusEvalError.fromException(result.exception)
		}

		return useJsonValue ? unwrapJsonValue<T>(result.result) : (result.result as T)
	}

	return {
		eval: runEval,
		evalValue,
		evalUntil: async (watcherId: string, expression: string, options: EvalUntilOptions = {}): Promise<EvalUntilResult> => {
			const predicate = options.predicate ?? ((value: unknown) => Boolean(value))
			const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
			const startTime = Date.now()

			const outcome = await pollEval<unknown, unknown>({
				intervalMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
				count: options.count,
				totalTimeoutMs,
				signal: options.signal,
				runEval: async () => {
					try {
						return { ok: true, response: await evalValue(watcherId, expression, options), attempt: 1 }
					} catch (error) {
						return { ok: false, failure: error, attempt: 1 }
					}
				},
				shouldStop: ({ response, iteration }) => {
					try {
						return { ok: true, matched: predicate(response, iteration) }
					} catch (error) {
						return { ok: false, error: `predicate threw: ${formatError(error)}` }
					}
				},
			})

			if (outcome.kind === 'matched') {
				return { value: outcome.response, iteration: outcome.iteration, elapsedMs: Date.now() - startTime }
			}

			throw toEvalUntilError(outcome, expression, totalTimeoutMs)
		},
	}
}

/**
 * A watcher predating the `jsonValue` flag ignores it and returns the raw value, which
 * would otherwise surface as a confusing JSON parse failure. Degrading silently is not an
 * option: the caller would lose the cross-transport key-order guarantee without knowing.
 */
const STALE_WATCHER_HINT =
	'Watcher did not honor `jsonValue`, so it is likely running a build that predates the flag. Restart the watcher to pick up the current build, or pass { jsonValue: false }.'

/** `JSON.stringify({ v: undefined })` — the envelope the watcher sends for a genuine `undefined`. */
const UNDEFINED_ENVELOPE = '{}'

/** Parse the `{ v }` envelope produced by the watcher's `jsonValue` mode. */
const unwrapJsonValue = <T>(raw: unknown): T => {
	if (typeof raw !== 'string') {
		throw new Error(STALE_WATCHER_HINT)
	}

	if (raw === UNDEFINED_ENVELOPE) {
		return undefined as T
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(STALE_WATCHER_HINT)
	}

	if (parsed == null || typeof parsed !== 'object' || !('v' in parsed)) {
		throw new Error(STALE_WATCHER_HINT)
	}

	return (parsed as { v: T }).v
}

/** Translate a non-matching poll outcome into the error `evalUntil` rejects with. */
const toEvalUntilError = (outcome: { kind: string; [key: string]: unknown }, expression: string, totalTimeoutMs: number): Error => {
	if (outcome.kind === 'eval-error') {
		return outcome.failure instanceof Error ? outcome.failure : new Error(formatError(outcome.failure))
	}

	if (outcome.kind === 'timeout') {
		return new Error(`evalUntil timed out after ${totalTimeoutMs}ms waiting for: ${expression}`)
	}

	if (outcome.kind === 'exhausted') {
		return new Error(`evalUntil exhausted ${String(outcome.iterations)} polls without a match for: ${expression}`)
	}

	if (outcome.kind === 'condition-error') {
		return new Error(String(outcome.error))
	}

	return new Error(`evalUntil aborted while waiting for: ${expression}`)
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
