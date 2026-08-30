import { getErrorCode } from '../errors.js'
import http from 'node:http'
import type { ErrorResponse, LogLevel } from '@vforsh/argus-core'

export const respondJson = <T extends object>(res: http.ServerResponse, body: T, status = 200): void => {
	const payload = JSON.stringify(body)
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json')
	res.end(payload)
}

export const respondInvalidMatch = (res: http.ServerResponse, message: string): void => {
	respondJson(res, { ok: false, error: { message, code: 'invalid_match' } } satisfies ErrorResponse, 400)
}

export const respondInvalidMatchCase = (res: http.ServerResponse): void => {
	respondJson(res, { ok: false, error: { message: 'Invalid matchCase value', code: 'invalid_match_case' } } satisfies ErrorResponse, 400)
}

export const respondInvalidBody = (res: http.ServerResponse, message: string): void => {
	respondJson(res, { ok: false, error: { message, code: 'invalid_request' } } satisfies ErrorResponse, 400)
}

export const respondInvalidJson = (res: http.ServerResponse): void => {
	respondJson(res, { ok: false, error: { message: 'Invalid JSON body', code: 'invalid_json' } } satisfies ErrorResponse, 400)
}

export const respondPayloadTooLarge = (res: http.ServerResponse): void => {
	respondJson(res, { ok: false, error: { message: 'Request body too large', code: 'payload_too_large' } } satisfies ErrorResponse, 413)
}

export const respondError = (res: http.ServerResponse, error: unknown): void => {
	const message = formatError(error)
	const code = getErrorCode(error)
	respondJson(res, { ok: false, error: { message, code } } satisfies ErrorResponse, 500)
}

/**
 * Read and parse a JSON request body.
 *
 * An absent or empty body yields `{}` rather than an error: `defineJsonRoute` hands the
 * result straight to a protocol schema, which rejects it with a real per-field message.
 * This used to be a documented gotcha ("routes must validate required fields explicitly")
 * because the empty object was cast to the route's body type and reached the handler
 * unvalidated; the schema layer now owns that proof.
 *
 * @returns The parsed body, or `null` when a response has already been sent (oversized
 *   payload or malformed JSON).
 */
export const readJsonBody = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | null> => {
	const chunks: Buffer[] = []
	let size = 0
	const maxBytes = 1_000_000

	try {
		for await (const chunk of req) {
			size += chunk.length
			if (size > maxBytes) {
				respondPayloadTooLarge(res)
				return null
			}
			chunks.push(Buffer.from(chunk))
		}
	} catch {
		respondInvalidJson(res)
		return null
	}

	if (chunks.length === 0) {
		return {}
	}

	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw.trim()) {
		return {}
	}

	try {
		return JSON.parse(raw)
	} catch {
		respondInvalidJson(res)
		return null
	}
}

/**
 * Read a numeric query param that always resolves to a number.
 *
 * Absent or non-numeric values fall back to `fallback`; in-range values are clamped
 * into `[min, max]`. Use {@link optionalNumber} when "absent" must stay distinguishable
 * from a real value — this function cannot express it.
 */
export const clampNumber = (value: string | null, fallback: number, min?: number, max?: number): number => {
	const parsed = value == null ? Number.NaN : Number(value)
	if (!Number.isFinite(parsed)) {
		return fallback
	}

	return clampToRange(parsed, min, max)
}

/**
 * Read an optional numeric query param.
 *
 * Returns `undefined` when the param is absent or non-numeric, so callers can tell
 * "not provided" from a provided `0`. Provided values are clamped into `[min, max]`.
 */
export const optionalNumber = (value: string | null, min?: number, max?: number): number | undefined => {
	if (value == null) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return undefined
	}

	return clampToRange(parsed, min, max)
}

/**
 * Read an optional positive-integer query param (buffer ids and other 1-based handles).
 *
 * Unlike {@link optionalNumber} this rejects rather than clamps: fractional, negative,
 * zero, and unsafe-integer values all yield `undefined` so a bad id can never be
 * silently coerced into a valid lookup.
 */
export const optionalPositiveInt = (value: string | null): number | undefined => {
	if (!value) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		return undefined
	}

	return parsed
}

const clampToRange = (parsed: number, min?: number, max?: number): number => {
	if (min != null && parsed < min) {
		return min
	}

	if (max != null && parsed > max) {
		return max
	}

	return parsed
}

export const parseLevels = (value: string | null): LogLevel[] | undefined => {
	if (!value) {
		return undefined
	}

	const levels = value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)

	if (levels.length === 0) {
		return undefined
	}

	return levels as LogLevel[]
}

export const resolveMatchCase = (value: string | null): 'sensitive' | 'insensitive' | null => {
	if (!value) {
		return 'insensitive'
	}

	if (value === 'sensitive' || value === 'insensitive') {
		return value
	}

	return null
}

export const normalizeMatchPatterns = (match: string[]): { patterns: string[]; error?: string } => {
	const patterns: string[] = []
	for (const pattern of match) {
		const trimmed = pattern.trim()
		if (!trimmed) {
			return { patterns: [], error: 'Invalid match pattern "(empty)"' }
		}
		patterns.push(trimmed)
	}

	return { patterns }
}

export const compileMatchPatterns = (patterns: string[], matchCase: 'sensitive' | 'insensitive'): { match?: RegExp[]; error?: string } => {
	if (patterns.length === 0) {
		return {}
	}

	const flags = matchCase === 'sensitive' ? '' : 'i'
	const compiled: RegExp[] = []

	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, flags))
		} catch (error) {
			return { error: `Invalid match pattern "${pattern}": ${formatError(error)}` }
		}
	}

	return { match: compiled }
}

export const normalizeQueryValue = (value: string | null): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}

	return trimmed
}

export const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
	if (value == null) {
		return fallback
	}
	return Boolean(value)
}

export const normalizeTimeout = (value: unknown): number | undefined => {
	if (value == null) {
		return undefined
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined
	}
	return parsed
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
