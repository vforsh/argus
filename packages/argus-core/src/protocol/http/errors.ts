/**
 * Machine-readable error codes the watcher emits.
 *
 * The `ok: false` envelope is a stated repo invariant, but `code` was a bare `string`, so a
 * watcher-side rename (say `body_not_available`) would silently stop matching the CLI check that
 * reads it. Codes travel two ways — written straight into a route's envelope, and carried on a
 * thrown `CodedError` that a route maps onto one — and both ends resolve to this union.
 *
 * Add a member here before emitting a new code; `isArgusErrorCode` keeps foreign codes (Node's
 * `ENOENT`, for instance) from leaking onto the wire when an arbitrary error is mapped.
 *
 * The CLI's own local failures (native-host setup, platform support, the `argus session` JSONL
 * transport) use the same envelope and so draw from the same union.
 */
export const ARGUS_ERROR_CODES = [
	'argus_executable_not_found',
	'body_not_available',
	'cdp_not_attached',
	'dialog_not_prompt',
	'extension_action_failed',
	'extension_frame_not_ready',
	'invalid_json',
	'invalid_match',
	'invalid_match_case',
	'invalid_net_filter',
	'invalid_net_request',
	'invalid_ref',
	'invalid_request',
	'log_epoch_evicted',
	'log_epoch_future',
	'log_epoch_invalid',
	'log_epoch_mismatch',
	'multiple_matches',
	'native_host_install_failed',
	'net_disabled',
	'net_request_not_found',
	'no_active_dialog',
	'not_available',
	'not_found',
	'not_interactable',
	'nth_out_of_range',
	'payload_too_large',
	'session_command_failed',
	'session_command_rejected',
	'session_invalid_request',
	'session_request_timeout',
	'session_unknown_command',
	'unexpected_matches',
	'unsupported_platform',
] as const

/** A machine-readable failure code carried by {@link ErrorDetail}. */
export type ArgusErrorCode = (typeof ARGUS_ERROR_CODES)[number]

/** True when `value` is a code this protocol defines. */
export const isArgusErrorCode = (value: unknown): value is ArgusErrorCode =>
	typeof value === 'string' && (ARGUS_ERROR_CODES as readonly string[]).includes(value)

/** Error detail carried by {@link ErrorResponse} and by inline `lastError` fields. */
export type ErrorDetail = {
	message: string
	code?: ArgusErrorCode
}

/** Standard error payload for API failures. */
export type ErrorResponse = {
	ok: false
	error: ErrorDetail
}

/**
 * A successful response payload, carrying the `ok: true` discriminant every Argus response shares.
 *
 * The envelope is a contract (see AGENTS.md), so it gets a type rather than being re-typed per
 * response — a payload that omits the discriminant or widens it to `boolean` no longer compiles.
 */
export type Ok<T> = { ok: true } & T

/**
 * Either a successful response or the standard failure envelope — what any watcher endpoint can
 * actually return. Consumers used to rebuild `T | ErrorResponse` by hand at every call site.
 */
export type ApiResult<TResponse extends { ok: true }> = TResponse | ErrorResponse

/**
 * A response payload with its `ok: true` discriminant removed.
 *
 * Consumers that already know a call succeeded (an SDK method that throws on failure,
 * for instance) return this instead of hand-retyping every field of the wire response —
 * so a new field on the protocol type reaches them for free.
 */
export type ResponseData<T extends { ok: true }> = Omit<T, 'ok'>
