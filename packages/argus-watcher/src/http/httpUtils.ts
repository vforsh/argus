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
	const code = resolveErrorCode(error)
	respondJson(res, { ok: false, error: { message, code } } satisfies ErrorResponse, 500)
}

export const readJsonBody = async <T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> => {
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
		return {} as T
	}

	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw.trim()) {
		return {} as T
	}

	try {
		return JSON.parse(raw) as T
	} catch {
		respondInvalidJson(res)
		return null
	}
}

export const clampNumber = (value: string | null, fallback?: number, min?: number, max?: number): number => {
	if (value == null) {
		return fallback ?? 0
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return fallback ?? 0
	}

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

export const compileMatchPatterns = (
	patterns: string[],
	matchCase: 'sensitive' | 'insensitive',
): { match?: RegExp[]; error?: string } => {
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

const resolveErrorCode = (error: unknown): string | undefined => {
	if (!error || typeof error !== 'object') {
		return undefined
	}
	if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
		return (error as { code: string }).code
	}
	return undefined
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
