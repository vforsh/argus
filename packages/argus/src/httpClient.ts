/** Fetch options for watcher HTTP calls. */
export type HttpOptions = {
	timeoutMs?: number
	method?: 'GET' | 'POST'
	body?: unknown
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

		if (!response.ok) {
			throw new Error(`Request failed (${response.status} ${response.statusText})`)
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
