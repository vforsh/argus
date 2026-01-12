const SENSITIVE_KEYS = new Set(['token', 'access_token', 'auth', 'authorization', 'code', 'password', 'pass'])

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
