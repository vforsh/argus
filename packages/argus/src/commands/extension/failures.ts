import type { ErrorResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../../output/io.js'
import { formatError } from '../../cli/parse.js'
import { formatWatcherLine } from '../../output/format.js'
import { getPlatform, type Platform } from './nativeHost.js'

/**
 * Failure reporting for the `argus extension` command family.
 *
 * These commands had grown thirteen local failure emitters between them, producing six
 * mutually incompatible machine-readable shapes (`{success, error:{message}}`,
 * `{success:false, error:string}`, `{configured:false, error}`, `{error}`,
 * `{ok:false, error:{message}}`, `{ok:false, error:string}`) — none of which matched the
 * envelope AGENTS.md and `argus-core/protocol/http/errors.ts` declare for the whole
 * product. They had already drifted: one emitter was missing its `else` and wrote both
 * the JSON document and the human lines.
 *
 * Everything here emits the canonical `{ ok: false, error: { message, code? } }`.
 */

/** One extra line of context printed after the error, e.g. a candidate watcher. */
export type FailureHint = string

export type EmitFailureInput = {
	/** The failure. Accepts a thrown value, a message, or an existing error response. */
	error: unknown
	/** Process exit code. Defaults to 1. */
	exitCode?: number
	/** Machine-readable code carried in the JSON envelope. */
	code?: string
	/** Lines printed after the message in human mode, and only in human mode. */
	hints?: readonly FailureHint[]
	/**
	 * Extra machine-readable fields placed beside `ok`/`error` in the JSON document.
	 *
	 * The envelope's invariant is `ok: false` plus `error: { message, code? }`; siblings
	 * such as a list of ambiguous matches do not violate it and are worth keeping for
	 * agents parsing the output.
	 */
	details?: Record<string, unknown>
}

/**
 * Report a failure and set `process.exitCode`.
 *
 * JSON mode writes exactly one document to stdout; human mode writes the message and any
 * hints to stderr. Never both — that mix was the bug in the emitter this replaces.
 */
export const emitFailure = (output: Output, input: EmitFailureInput): void => {
	const message = toMessage(input.error)
	const code = input.code ?? extractCode(input.error)

	if (output.json) {
		output.writeJson({ ok: false, error: code ? { message, code } : { message }, ...input.details } satisfies ErrorResponse)
	} else {
		output.writeWarn(message)
		for (const hint of input.hints ?? []) {
			output.writeWarn(hint)
		}
	}

	process.exitCode = input.exitCode ?? 1
}

/**
 * Report a watcher-resolution failure, listing the candidates that made it ambiguous.
 *
 * @param hint Trailing guidance for the human path, e.g. how to disambiguate.
 */
export const emitResolveFailure = (
	output: Output,
	resolved: { error: string; exitCode: number; candidates?: readonly WatcherRecord[] },
	hint = 'Hint: pass --id <watcherId> to pick one extension watcher.',
): void => {
	const candidates = resolved.candidates ?? []
	emitFailure(output, {
		error: resolved.error,
		exitCode: resolved.exitCode,
		hints: candidates.length > 0 ? [...candidates.map((watcher) => formatWatcherLine(watcher)), hint] : [],
	})
}

/**
 * Resolve the host platform, reporting the failure if it is unsupported.
 *
 * Five commands opened with the identical try/catch around `getPlatform()`.
 *
 * @returns The platform, or `null` when a failure has already been reported.
 */
export const getPlatformOrFail = (output: Output): Platform | null => {
	try {
		return getPlatform()
	} catch (error) {
		emitFailure(output, { error, code: 'unsupported_platform' })
		return null
	}
}

/** Pull a message out of a thrown value, a string, or an error response. */
const toMessage = (error: unknown): string => {
	if (typeof error === 'string') {
		return error
	}
	if (isErrorResponse(error)) {
		return error.error.message
	}
	return formatError(error)
}

/** Preserve a code the watcher already assigned rather than inventing a new one. */
const extractCode = (error: unknown): string | undefined => (isErrorResponse(error) ? error.error.code : undefined)

const isErrorResponse = (value: unknown): value is ErrorResponse =>
	typeof value === 'object' &&
	value != null &&
	'ok' in value &&
	(value as ErrorResponse).ok === false &&
	typeof (value as ErrorResponse).error?.message === 'string'
