import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalNumber, optionalRecord, readFields, requireObject, requiredString } from '../schemaFields.js'
import type { Ok } from './errors.js'

/** Request payload for POST /eval. */
export type EvalRequest = {
	expression: string
	/**
	 * String-only values exposed to evaluated code as `args`.
	 * Watchers install them for the duration of the eval without rewriting source.
	 */
	args?: Record<string, string>
	awaitPromise?: boolean
	/**
	 * Enable Chrome's REPL evaluation mode.
	 * This allows native top-level `await` and console-like repeated declarations.
	 */
	replMode?: boolean
	timeoutMs?: number
	returnByValue?: boolean
	/**
	 * Serialize the result with `JSON.stringify` inside the page and return that
	 * string as `result`, wrapped as `{"v":<value>}` so a genuine `undefined`
	 * round-trips. Callers parse it and read `.v`.
	 *
	 * Transports disagree about raw `returnByValue` results: the extension relay
	 * (Chrome's `chrome.debugger` serialization) returns object keys sorted
	 * alphabetically at every nesting level, while a direct CDP watcher preserves
	 * insertion order. Values are identical either way, but structural comparisons
	 * of the same page state produce different bytes per transport. Serializing in
	 * the page normalizes both to insertion order, and makes `Date` round-trip as
	 * an ISO string (via `toJSON`) instead of `{}`.
	 *
	 * Evaluation semantics are untouched: REPL mode, statement lists, top-level
	 * `await`, and promise unwrapping all behave exactly as without this flag.
	 */
	jsonValue?: boolean
	/** Install the temporary host bridge used by bundled scenario modules. */
	scenario?: boolean
}

/** Response payload for POST /eval. */
export type EvalResponse = Ok<{
	result: unknown
	type: string | null
	exception: { text: string; details?: unknown } | null
	/**
	 * Present when a bundled scenario exceeded `timeoutMs` after calling `ctx.progress()`.
	 * `result` is then the last progress value rather than the scenario's return value, and
	 * `code`/`message` carry the watcher's diagnosis of why the deadline was missed.
	 */
	timedOut?: EvalTimedOut
}>

/** Why a scenario eval stopped early; see `EvalResponse.timedOut`. */
export type EvalTimedOut = {
	code: string
	message: string
	/** Epoch milliseconds of the `ctx.progress()` call that produced `result`. */
	progressAt: number
}

/** Schema for POST /eval request payloads. */
export const evalRequestSchema = defineProtocolSchema<EvalRequest>((value) => {
	const invalid = requireObject<EvalRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const fields = readFields(source, {
		expression: requiredString,
		awaitPromise: optionalBoolean,
		replMode: optionalBoolean,
		returnByValue: optionalBoolean,
		jsonValue: optionalBoolean,
		scenario: optionalBoolean,
		timeoutMs: (input, key) => optionalNumber(input, key, { min: 0 }),
		// `args` is string-only by contract; the eval runtime re-checks each entry before
		// installing it, so the schema only rejects an outright wrong container shape.
		args: optionalRecord,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact({ ...fields.value, args: fields.value.args as Record<string, string> | undefined }))
})

/** Descriptions the watcher sends for falsy values CDP cannot return by value. */
const FALSY_UNSERIALIZABLE: Readonly<Record<string, readonly string[]>> = {
	number: ['NaN', '-0'],
	bigint: ['0n'],
}

/**
 * JavaScript truthiness of an eval reply's `result`.
 *
 * CDP cannot return `undefined`, `NaN`, `-0` or bigints by value, so the watcher sends their
 * descriptions as strings ("undefined", "NaN", "-0", "0n") — all of which `Boolean()` calls
 * truthy. Polling on `Boolean(result)` therefore matched `window.APP_READY` before the app set it.
 *
 * @param response - An eval reply; only `result` and `type` are read.
 * @returns Whether the evaluated value was truthy in the page.
 */
export const isTruthyEvalResult = (response: Pick<EvalResponse, 'result' | 'type'>): boolean => {
	if (response.type === 'undefined') return false
	if (typeof response.result === 'string' && response.type != null && FALSY_UNSERIALIZABLE[response.type]?.includes(response.result)) {
		return false
	}
	return Boolean(response.result)
}
