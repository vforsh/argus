/** Fetch options for watcher HTTP calls. */
export type HttpOptions = {
	timeoutMs?: number
	method?: 'GET' | 'POST' | 'PUT'
	body?: unknown
	/** If true, return JSON body for 4xx responses instead of throwing. Default: false. */
	returnErrorResponse?: boolean
}

/** Fetch JSON with timeout and typed response. */
export const fetchJson = async <T>(url: string, options: HttpOptions = {}): Promise<T> => {
	const controller = new AbortController()
	const timeoutMs = options.timeoutMs ?? 5_000
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const body = options.body != null ? JSON.stringify(options.body) : undefined

	try {
		const response = await fetch(url, {
			method: options.method ?? 'GET',
			signal: controller.signal,
			body,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
		})

		// For error responses, try to extract the error message from the JSON body
		if (!response.ok) {
			if (options.returnErrorResponse && response.status >= 400) {
				return (await response.json()) as T
			}
			// Try to read the error message from the response body
			const errorMessage = await extractErrorMessage(response)
			throw new Error(errorMessage ?? `Request failed (${response.status} ${response.statusText})`)
		}

		return (await response.json()) as T
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error(`Request timed out after ${timeoutMs}ms`)
		}
		throw error
	} finally {
		clearTimeout(timer)
	}
}

const isAbortError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object' || !('name' in error)) {
		return false
	}

	return (error as { name: string }).name === 'AbortError'
}

/** Try to extract an error message from a response's JSON body. */
const extractErrorMessage = async (response: Response): Promise<string | null> => {
	try {
		const body = await response.json()
		if (body && typeof body === 'object' && 'error' in body) {
			const error = (body as { error?: unknown }).error
			if (error && typeof error === 'object' && 'message' in error) {
				return (error as { message: string }).message
			}
		}
	} catch {
		// Ignore JSON parse errors - fall back to status text
	}
	return null
}

/** Fetch text with timeout. */
export const fetchText = async (url: string, options: HttpOptions = {}): Promise<string> => {
	const controller = new AbortController()
	const timeoutMs = options.timeoutMs ?? 5_000
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const body = options.body != null ? JSON.stringify(options.body) : undefined

	try {
		const response = await fetch(url, {
			method: options.method ?? 'GET',
			signal: controller.signal,
			body,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
		})

		if (!response.ok) {
			throw new Error(`Request failed (${response.status} ${response.statusText})`)
		}

		return await response.text()
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error(`Request timed out after ${timeoutMs}ms`)
		}
		throw error
	} finally {
		clearTimeout(timer)
	}
}
