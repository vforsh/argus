import type { ArgusErrorCode, ErrorResponse, EvalResponse } from '@vforsh/argus-core'
import type { EvalFailureKind } from '../eval/evalClient.js'
import { isArgusErrorCode, previewStringify } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { projectFields, truncateJsonValue, truncateText, type OutputShaping } from '../output/projection.js'
import { createEvalResultFileSink, formatEvalValue, type EvalResultFileOptions } from './evalResultOutput.js'

/**
 * Where an eval result goes: stdout/stderr, and optionally the `--out` file.
 *
 * Split out of `evalShared.ts`, which had grown to hold five unrelated concerns.
 */

/** Format an exception response into a human-readable string. */
export const formatException = (response: EvalResponse): string => {
	if (!response.exception) {
		return ''
	}
	if (response.exception.details) {
		return `Exception: ${response.exception.text}\n${previewStringify(response.exception.details)}`
	}
	return `Exception: ${response.exception.text}`
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Failure shape used by eval emitters. */
export type EvalAttemptFailure = {
	ok: false
	kind: EvalFailureKind
	error: string
	code?: ArgusErrorCode
	response?: EvalResponse
	attempt: number
}

export type EvalEmitOptions = EvalResultFileOptions & {
	json?: boolean
	silent?: boolean
}

/** Writes eval results to stdout/stderr and optionally to `--out`. */
export type EvalEmitter = {
	emitSuccess: (response: EvalResponse, streaming: boolean) => Promise<void>
	emitError: (error: EvalAttemptFailure | { kind: 'until'; error: string }, streaming?: boolean) => Promise<void>
}

/** Create stdout/stderr and optional file sinks for eval command output. */
export const createEvalEmitter = (options: EvalEmitOptions, output: Output, shaping: OutputShaping = {}): EvalEmitter => {
	const fileSink = createEvalResultFileSink(options)

	return {
		emitSuccess: async (response, streaming) => {
			await fileSink?.write(response, streaming)
			writeEvalSuccess(response, options, output, streaming, shaping)

			if (fileSink && !streaming && !options.silent) {
				output.writeHuman(`Result saved: ${fileSink.displayPath}`)
			}
		},
		emitError: async (error, streaming = false) => {
			// A timed-out scenario still carries its last progress value: keep it wherever a result would go.
			if (error.kind === 'timeout' && 'response' in error && error.response) {
				await fileSink?.write(error.response, streaming)
			}
			writeEvalError(error, options, output, streaming)
		},
	}
}

/** Write a successful eval response to stdout/stderr only. */
export const writeEvalSuccess = (
	response: EvalResponse,
	options: EvalEmitOptions,
	output: Output,
	streaming: boolean,
	shaping: OutputShaping = {},
): void => {
	if (options.silent) {
		return
	}

	if (options.json) {
		const document = shapeEvalJson(response, shaping)
		if (streaming) {
			output.writeJsonLine(document)
		} else {
			output.writeJson(document)
		}
		return
	}

	if (response.exception) {
		output.writeHuman(formatException(response))
		return
	}

	output.writeHuman(truncateText(formatEvalValue(projectFields(response.result, shaping.fields)), shaping.maxChars))
}

/**
 * Apply `--fields` / `--max-chars` to the `result` of a JSON eval reply.
 *
 * Over budget, `result` becomes the serialized prefix (a string) beside `truncated: true` and
 * `totalChars` (the full serialized length), so the document stays one valid JSON object.
 */
const shapeEvalJson = (response: EvalResponse, shaping: OutputShaping): EvalResponse | (EvalResponse & { truncated: true; totalChars: number }) => {
	if (!shaping.fields && shaping.maxChars === undefined) return response

	const capped = truncateJsonValue(projectFields(response.result, shaping.fields), shaping.maxChars)
	if (!capped.truncated) return { ...response, result: capped.value }
	return { ...response, result: capped.value, truncated: true, totalChars: capped.totalChars }
}

/** Write an eval error to stdout/stderr only. */
const writeEvalError = (error: EvalAttemptFailure | { kind: 'until'; error: string }, options: EvalEmitOptions, output: Output, streaming: boolean): void => {
	if (options.json) {
		const envelope = formatEvalErrorJson(error)
		if (streaming) {
			output.writeJsonLine(envelope)
		} else {
			output.writeJson(envelope)
		}
		return
	}

	if (error.kind === 'timeout' && 'response' in error && error.response && !options.json && !options.silent) {
		output.writeHuman(formatEvalValue(error.response.result))
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		output.writeWarn(formatException(error.response))
		return
	}

	output.writeWarn(error.error)
}

/**
 * One `ok: false` document per failed eval, so `--json` consumers branch on `ok` alone.
 *
 * This used to print the raw watcher reply — `ok: true` beside an `exception`, with CDP's
 * `objectId` noise — followed by the same exception again on stderr, and nothing at all on
 * stdout for transport failures. A timed-out scenario keeps `result`/`timedOut` beside the
 * envelope: its last `ctx.progress()` value is the point of the reply.
 */
const formatEvalErrorJson = (error: EvalAttemptFailure | { kind: 'until'; error: string }): ErrorResponse & Record<string, unknown> => {
	if (error.kind === 'exception' && error.response?.exception) {
		const { text, details } = error.response.exception
		const description = describeExceptionDetails(details)
		return {
			ok: false,
			error: { message: description?.split('\n')[0] ?? `Exception: ${text}`, code: 'eval_exception' },
			exception: description ? { text, description } : { text },
		}
	}
	if (error.kind === 'timeout' && error.response) {
		// Keep the watcher's stall diagnosis (`extension_bridge_unresponsive`, `dialog_blocking`, …):
		// it picks the recovery. `cdp_timeout` is only the fallback for an unrecognized code.
		const diagnosed = error.response.timedOut?.code
		const code = isArgusErrorCode(diagnosed) ? diagnosed : 'cdp_timeout'
		return { ok: false, error: { message: error.error, code }, result: error.response.result, timedOut: error.response.timedOut }
	}
	if (error.kind === 'transport' && error.code) {
		return { ok: false, error: { message: error.error, code: error.code } }
	}
	return { ok: false, error: { message: error.error } }
}

/** CDP puts the thrown value's `description` (message + stack) on `details`; keep only that. */
export const describeExceptionDetails = (details: unknown): string | undefined => {
	if (!details || typeof details !== 'object') return undefined
	const description = (details as { description?: unknown }).description
	return typeof description === 'string' && description !== '' ? description : undefined
}
