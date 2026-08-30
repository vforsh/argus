import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { createEvalResultFileSink, type EvalResultFileOptions } from './evalResultOutput.js'

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
	kind: 'transport' | 'exception'
	error: string
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
	emitError: (error: EvalAttemptFailure | { kind: 'until'; error: string }) => void
}

/** Create stdout/stderr and optional file sinks for eval command output. */
export const createEvalEmitter = (options: EvalEmitOptions, output: Output): EvalEmitter => {
	const fileSink = createEvalResultFileSink(options)

	return {
		emitSuccess: async (response, streaming) => {
			await fileSink?.write(response, streaming)
			writeEvalSuccess(response, options, output, streaming)

			if (fileSink && !streaming && !options.silent) {
				output.writeHuman(`Result saved: ${fileSink.displayPath}`)
			}
		},
		emitError: (error) => {
			writeEvalError(error, options, output)
		},
	}
}

/** Write a successful eval response to stdout/stderr only. */
export const writeEvalSuccess = (response: EvalResponse, options: EvalEmitOptions, output: Output, streaming: boolean): void => {
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

/** Write an eval error to stdout/stderr only. */
const writeEvalError = (error: EvalAttemptFailure | { kind: 'until'; error: string }, options: EvalEmitOptions, output: Output): void => {
	if (options.json && 'response' in error && error.response) {
		output.writeJsonLine(error.response)
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		output.writeWarn(formatException(error.response))
		return
	}

	output.writeWarn(error.error)
}
