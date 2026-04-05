const SENSITIVE_KEYS = new Set(['token', 'access_token', 'auth', 'authorization', 'code', 'password', 'pass'])
const AUTH_HEADER_NAMES = new Set([
	'authorization',
	'cookie',
	'set-cookie',
	'x-api-key',
	'x-auth-token',
	'x-csrf-token',
	'x-csrftoken',
	'x-xsrf-token',
	'csrf-token',
	'xsrf-token',
])

/** Redact URL query values while preserving keys. */
export const redactUrl = (value: string): string => {
	if (!value) {
		return value
	}

	let url: URL
	try {
		url = new URL(value)
	} catch {
		return value
	}

	if (!url.search) {
		return value
	}

	const params = new URLSearchParams(url.search)
	const redacted = new URLSearchParams()

	for (const [key, val] of params.entries()) {
		const trimmedKey = key.trim()
		if (!trimmedKey) {
			continue
		}
		const lowerKey = trimmedKey.toLowerCase()
		if (SENSITIVE_KEYS.has(lowerKey) && val.trim()) {
			redacted.append(trimmedKey, 'redacted')
			continue
		}
		redacted.append(trimmedKey, '')
	}

	const search = redacted.toString()
	url.search = search ? `?${search}` : ''
	return url.toString()
}

/** Pick a narrow allowlist of auth-related headers and redact their values. */
export const pickCapturedAuthHeaders = (headers: Record<string, unknown> | undefined): Record<string, string> | undefined => {
	if (!headers) {
		return undefined
	}

	const captured: Record<string, string> = {}

	for (const [name, rawValue] of Object.entries(headers)) {
		const normalizedName = name.trim().toLowerCase()
		if (!normalizedName || !AUTH_HEADER_NAMES.has(normalizedName)) {
			continue
		}

		const value = normalizeHeaderValue(rawValue)
		if (!value) {
			continue
		}

		captured[normalizedName] = redactHeaderValue(normalizedName, value)
	}

	return Object.keys(captured).length > 0 ? captured : undefined
}

/** Capture all headers while redacting sensitive values. */
export const captureHeaders = (headers: Record<string, unknown> | undefined): Record<string, string> | undefined => {
	if (!headers) {
		return undefined
	}

	const captured: Record<string, string> = {}

	for (const [name, rawValue] of Object.entries(headers)) {
		const normalizedName = name.trim().toLowerCase()
		if (!normalizedName) {
			continue
		}

		const value = normalizeHeaderValue(rawValue)
		if (!value) {
			continue
		}

		captured[normalizedName] = shouldRedactHeader(normalizedName) ? redactHeaderValue(normalizedName, value) : value
	}

	return Object.keys(captured).length > 0 ? captured : undefined
}

/** Merge two captured auth-header maps, preferring newer values for the same header name. */
export const mergeCapturedAuthHeaders = (
	current: Record<string, string> | undefined,
	incoming: Record<string, string> | undefined,
): Record<string, string> | undefined => {
	if (!current) {
		return incoming
	}
	if (!incoming) {
		return current
	}

	return { ...current, ...incoming }
}

/** Merge two captured header maps, preferring newer values for the same header name. */
export const mergeCapturedHeaders = (
	current: Record<string, string> | undefined,
	incoming: Record<string, string> | undefined,
): Record<string, string> | undefined => {
	if (!current) {
		return incoming
	}
	if (!incoming) {
		return current
	}

	return { ...current, ...incoming }
}

const normalizeHeaderValue = (value: unknown): string | null => {
	if (typeof value === 'string') {
		const trimmed = value.trim()
		return trimmed || null
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	}

	if (Array.isArray(value)) {
		const joined = value
			.map((item) => normalizeHeaderValue(item))
			.filter((item): item is string => Boolean(item))
			.join(', ')
		return joined || null
	}

	return null
}

const redactHeaderValue = (name: string, value: string): string => {
	if (name === 'authorization') {
		return redactAuthorizationHeader(value)
	}

	if (name === 'cookie' || name === 'set-cookie') {
		return redactCookieHeader(value)
	}

	return redactToken(value)
}

const shouldRedactHeader = (name: string): boolean => {
	if (AUTH_HEADER_NAMES.has(name)) {
		return true
	}

	return name.includes('token') || name.includes('secret') || name.includes('auth') || name.includes('key') || name.includes('session')
}

const redactAuthorizationHeader = (value: string): string => {
	const match = value.match(/^([A-Za-z]+)\s+(.+)$/)
	if (!match) {
		return redactToken(value)
	}

	return `${match[1]} ${redactToken(match[2])}`
}

const redactCookieHeader = (value: string): string => {
	const parts = value
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [name] = entry.split('=')
			return name ? `${name}=<redacted>` : null
		})
		.filter((entry): entry is string => Boolean(entry))

	return parts.join('; ')
}

const redactToken = (value: string): string => {
	if (value.length <= 8) {
		return '*'.repeat(value.length)
	}

	return `${value.slice(0, 4)}...${value.slice(-4)}`
}
