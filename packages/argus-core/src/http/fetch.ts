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

/**
 * Thrown when a request exceeded its timeout budget.
 *
 * Distinct from a connection failure: a slow endpoint on a perfectly healthy peer produces this,
 * so callers that treat failures as liveness signals — registry pruning — must not evict on it.
 * Typed rather than message-matched because `fetch`'s connection errors carry runtime-specific
 * shapes (Bun sets `code: 'ConnectionRefused'`, Node nests an errno under `cause`), so the timeout
 * is the one failure we can identify reliably ourselves.
 */
export class HttpTimeoutError extends Error {
	/** The budget that elapsed, in milliseconds. */
	readonly timeoutMs: number

	/** Brand, so the check survives two copies of this module in one process. */
	readonly isHttpTimeoutError = true

	constructor(timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`)
		this.name = 'HttpTimeoutError'
		this.timeoutMs = timeoutMs
	}
}

/** Type guard for {@link HttpTimeoutError} that tolerates duplicate module instances. */
export const isHttpTimeoutError = (error: unknown): error is HttpTimeoutError =>
	error != null && typeof error === 'object' && (error as { isHttpTimeoutError?: unknown }).isHttpTimeoutError === true

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
			throw new HttpTimeoutError(timeoutMs)
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
			throw new HttpTimeoutError(timeoutMs)
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
