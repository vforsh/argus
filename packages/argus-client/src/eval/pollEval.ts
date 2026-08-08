/**
 * Transport-agnostic eval polling loop shared by the CLI (`eval --interval`,
 * `eval-until`) and the SDK (`evalUntil`), so loop semantics stay identical.
 *
 * The loop owns only timing and stop conditions. Everything environment-specific —
 * how an eval is performed, retry policy, signal handling, output — is injected by
 * the caller. In particular this module installs no process listeners: cancellation
 * is an `AbortSignal` so it stays safe to use inside a library.
 */

/** Per-iteration context handed to stop conditions and result observers. */
export type EvalPollContext<TResponse> = {
	response: TResponse
	/** 1-based poll iteration. */
	iteration: number
	/** 1-based attempt number within the iteration, when the caller retries. */
	attempt: number
}

/** Verdict from a stop condition: matched, not matched, or the condition itself failed. */
export type EvalPollStopDecision = { ok: true; matched: boolean } | { ok: false; error: string }

/** Outcome of one injected eval attempt. */
export type EvalPollAttempt<TResponse, TFailure> =
	| { ok: true; response: TResponse; attempt: number }
	| { ok: false; failure: TFailure; attempt: number }

/** Inputs for {@link pollEval}. */
export type EvalPollInput<TResponse, TFailure> = {
	/** Perform one eval. Callers wrap their own retry policy in here. */
	runEval: (iteration: number) => Promise<EvalPollAttempt<TResponse, TFailure>>
	/** Delay between polls in milliseconds. */
	intervalMs: number
	/** Stop after this many polls. Unlimited when omitted. */
	count?: number
	/** Give up after this much wall-clock time. Unlimited when omitted. */
	totalTimeoutMs?: number
	/** Decide whether to stop. Omitted means "never match" — useful for streaming. */
	shouldStop?: (context: EvalPollContext<TResponse>) => EvalPollStopDecision
	/** Observe every result, including the matching one. */
	onResult?: (response: TResponse, context: EvalPollContext<TResponse>) => void | Promise<void>
	/** Cancel the loop. Yields an `interrupted` outcome rather than throwing. */
	signal?: AbortSignal
}

/** Terminal state of a poll loop. */
export type EvalPollOutcome<TResponse, TFailure> =
	| { kind: 'matched'; response: TResponse; iteration: number; attempt: number }
	| { kind: 'exhausted'; iterations: number }
	| { kind: 'timeout'; elapsedMs: number }
	| { kind: 'interrupted' }
	| { kind: 'eval-error'; failure: TFailure }
	| { kind: 'condition-error'; error: string }

/**
 * Poll `runEval` until a stop condition matches, the budget runs out, or the signal aborts.
 *
 * Results are reported to `onResult` before stop conditions are checked, so streaming
 * callers print the matching iteration too.
 */
export const pollEval = async <TResponse, TFailure>(input: EvalPollInput<TResponse, TFailure>): Promise<EvalPollOutcome<TResponse, TFailure>> => {
	const startTime = Date.now()
	let iteration = 0

	while (!input.signal?.aborted) {
		if (input.totalTimeoutMs != null) {
			const elapsedMs = Date.now() - startTime
			if (elapsedMs >= input.totalTimeoutMs) {
				return { kind: 'timeout', elapsedMs }
			}
		}

		iteration += 1
		const result = await input.runEval(iteration)
		if (!result.ok) {
			return { kind: 'eval-error', failure: result.failure }
		}

		const context: EvalPollContext<TResponse> = { response: result.response, iteration, attempt: result.attempt }
		// Streaming callers print the matched iteration too, so emit before checking stop conditions.
		await input.onResult?.(result.response, context)

		const decision = input.shouldStop?.(context)
		if (decision) {
			if (!decision.ok) {
				return { kind: 'condition-error', error: decision.error }
			}
			if (decision.matched) {
				return { kind: 'matched', response: result.response, iteration, attempt: result.attempt }
			}
		}

		if (input.count != null && iteration >= input.count) {
			return { kind: 'exhausted', iterations: iteration }
		}

		await sleep(input.intervalMs, input.signal)
	}

	return { kind: 'interrupted' }
}

/** Resolve after `durationMs`, or immediately once `signal` aborts. */
const sleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
	if (signal?.aborted) {
		return
	}

	await new Promise<void>((resolve) => {
		const finish = (): void => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			resolve()
		}

		const timer = setTimeout(finish, durationMs)
		signal?.addEventListener('abort', finish, { once: true })
	})
}
