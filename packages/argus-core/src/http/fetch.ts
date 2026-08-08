export type HttpMethod = 'GET' | 'POST' | 'PUT'

/**
 * Thrown when the server answered with a non-2xx status.
 *
 * Distinct from a transport failure (connection refused, DNS, timeout): the peer is
 * alive and rejected this specific request. Callers that treat failures as liveness
 * signals — such as registry pruning — must not evict a peer that threw this.
 */
export class HttpResponseError extends Error {
	/** HTTP status code returned by the server. */
	readonly status: number

	/** Brand, so the check survives two copies of this module in one process. */
	readonly isHttpResponseError = true

	constructor(message: string, status: number) {
		super(message)
		this.name = 'HttpResponseError'
		this.status = status
	}
}

/** Type guard for {@link HttpResponseError} that tolerates duplicate module instances. */
export const isHttpResponseError = (error: unknown): error is HttpResponseError =>
	error != null && typeof error === 'object' && (error as { isHttpResponseError?: unknown }).isHttpResponseError === true

export type HttpOptions = {
	timeoutMs?: number
	method?: HttpMethod
	body?: unknown
	/** If true, return JSON body for 4xx responses instead of throwing. Default: false. */
	returnErrorResponse?: boolean
}

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
			if (options.returnErrorResponse && response.status >= 400) {
				return (await response.json()) as T
			}

			const errorMessage = await extractErrorMessage(response)
			throw new HttpResponseError(errorMessage ?? `Request failed (${response.status} ${response.statusText})`, response.status)
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
			throw new HttpResponseError(`Request failed (${response.status} ${response.statusText})`, response.status)
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

const isAbortError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object' || !('name' in error)) {
		return false
	}

	return (error as { name: string }).name === 'AbortError'
}

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
