import type { ErrorDetail } from './http/errors.js'
import {
	compact,
	fieldError,
	optionalRecord,
	optionalStringArray,
	readFields,
	requireObject,
	requiredString,
	type FieldError,
} from './schemaFields.js'
import { defineProtocolSchema, invalidProtocolPayload, type ProtocolSchema } from './schema.js'

/**
 * Wire version of the `argus session` JSONL transport.
 *
 * Independent of `ARGUS_PROTOCOL_VERSION`: this describes the stdin/stdout framing
 * between a host process and the CLI, not the CLI/watcher HTTP contract. Bump it when a
 * host that parsed the old framing would misread the new one; adding an optional response
 * field is not that.
 */
export const SESSION_PROTOCOL_VERSION = 1 as const

/** Correlation id echoed from a request onto its response. */
export type SessionRequestId = string | number

/**
 * One request line on the session's stdin.
 *
 * `args` and `argv` are two spellings of the same thing and are mutually exclusive:
 * `args` is a named map resolved against the command's own Commander definition, `argv`
 * is the raw token list a host that already builds CLI arrays can pass straight through.
 */
export type SessionRequest = {
	/** Echoed back on the response. Omit only if the host correlates by order. */
	id?: SessionRequestId
	/** Command path, space-separated (`eval`, `dom tree`). Aliases are accepted. */
	cmd: string
	/** Named arguments mapped onto the command's options and positional arguments. */
	args?: Record<string, unknown>
	/** Raw CLI tokens, as an alternative to `args`. */
	argv?: string[]
	/** Per-request watchdog, in `parseDurationMs` syntax (`30s`) or milliseconds. */
	timeout?: string | number
}

/** First line the session writes, before it reads any request. */
export type SessionReadyEvent = {
	type: 'ready'
	protocolVersion: typeof SESSION_PROTOCOL_VERSION
	argusVersion: string
	watcher: { id: string; host: string; port: number }
}

/** Fields shared by both response arms. */
type SessionResponseBase = {
	id?: SessionRequestId
	/** Wall-clock time the CLI spent on the request. */
	durationMs: number
	/** Anything the command wrote to stderr, when non-empty. Also mirrored to the session's stderr. */
	stderr?: string
}

/** A request the CLI completed with exit code 0. */
export type SessionSuccessResponse = SessionResponseBase & {
	ok: true
	/**
	 * The command's `--json` payload.
	 *
	 * A single JSON document decodes to itself; a command that streamed newline-delimited
	 * JSON yields an array with `stream: true`; output that is not JSON at all is passed
	 * through verbatim as a string with `raw: true`.
	 */
	result: unknown
	stream?: true
	raw?: true
}

/** A request that failed — bad framing, unknown command, non-zero exit, or watchdog. */
export type SessionErrorResponse = SessionResponseBase & {
	ok: false
	error: ErrorDetail
	/** The `process.exitCode` the command set, or `1` for transport-level failures. */
	exitCode: number
}

export type SessionResponse = SessionSuccessResponse | SessionErrorResponse

/** Anything the session writes to stdout, one JSON document per line. */
export type SessionOutputLine = SessionReadyEvent | SessionResponse

/** Read the optional `id` field, which may be a string or a number. */
const optionalRequestId = (source: Record<string, unknown>, key: string): SessionRequestId | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field === 'string') {
		return field
	}
	if (typeof field === 'number' && Number.isFinite(field)) {
		return field
	}
	return fieldError(`${key} must be a string or a finite number`)
}

/** Read the optional `timeout` field, which may be a duration string or milliseconds. */
const optionalTimeout = (source: Record<string, unknown>, key: string): string | number | undefined | FieldError => {
	const field = source[key]
	if (field == null) {
		return undefined
	}
	if (typeof field === 'string') {
		return field
	}
	if (typeof field === 'number' && Number.isFinite(field) && field > 0) {
		return field
	}
	return fieldError(`${key} must be a duration string or a positive number of milliseconds`)
}

/**
 * Validate one decoded request line.
 *
 * Framing failures are answered, not thrown: the session stays alive and the host learns
 * which field it got wrong, so a typo in one request cannot take down a replay.
 */
export const SESSION_REQUEST_SCHEMA: ProtocolSchema<SessionRequest> = defineProtocolSchema<SessionRequest>((value) => {
	const invalid = requireObject<SessionRequest>(value)
	if (invalid) return invalid

	const source = value as Record<string, unknown>
	const fields = readFields(source, {
		id: optionalRequestId,
		cmd: requiredString,
		args: optionalRecord,
		argv: optionalStringArray,
		timeout: optionalTimeout,
	})
	if (!fields.ok) return fields

	if (fields.value.args && fields.value.argv) {
		return invalidProtocolPayload<SessionRequest>('args and argv are mutually exclusive')
	}

	return { ok: true, value: compact(fields.value) }
})
