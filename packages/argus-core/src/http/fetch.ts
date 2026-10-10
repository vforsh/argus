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
	/** Structured server error code, when the peer returned an error envelope. */
	readonly code?: string

	/** Brand, so the check survives two copies of this module in one process. */
	readonly isHttpResponseError = true

	constructor(message: string, status: number, code?: string) {
		super(message)
		this.name = 'HttpResponseError'
		this.status = status
		this.code = code
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

/** Local cancellation; it does not prove a dispatched browser operation was undone. */
export class HttpRequestAbortedError extends Error {
	readonly isHttpRequestAbortedError = true
	constructor() {
		super('Request cancelled.')
		this.name = 'HttpRequestAbortedError'
	}
}

/** Cross-module cancellation guard. */
export const isHttpRequestAbortedError = (error: unknown): error is HttpRequestAbortedError =>
	error != null && typeof error === 'object' && (error as { isHttpRequestAbortedError?: unknown }).isHttpRequestAbortedError === true

export type HttpOptions = {
	/** Cancel local waiting; does not roll back remote effects. */
	signal?: AbortSignal
	/** Absolute Unix millisecond deadline, also bounding response-body reads. */
	deadline?: number
	timeoutMs?: number
	method?: HttpMethod
	body?: unknown
	/** If true, return JSON body for 4xx responses instead of throwing. Default: false. */
	returnErrorResponse?: boolean
}

/** Fetch JSON with a bounded response/body read and optional request cancellation. */
export const fetchJson = <T>(url: string, options: HttpOptions = {}): Promise<T> =>
	withHttpResponse(url, options, async (response) => {
		if (response.ok || (options.returnErrorResponse && response.status >= 400)) {
			try {
				return (await response.json()) as T
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error
				throw new HttpResponseError('Watcher returned invalid JSON.', response.status, 'invalid_json')
			}
		}
		const detail = await extractErrorDetail(response)
		throw new HttpResponseError(detail?.message ?? `Request failed (${response.status} ${response.statusText})`, response.status, detail?.code)
	})

/** Fetch text with the same deadline and cancellation semantics as JSON. */
export const fetchText = (url: string, options: HttpOptions = {}): Promise<string> =>
	withHttpResponse(url, options, async (response) => {
		if (!response.ok) throw new HttpResponseError(`Request failed (${response.status} ${response.statusText})`, response.status)
		return response.text()
	})

const withHttpResponse = async <T>(url: string, options: HttpOptions, read: (response: Response) => Promise<T>): Promise<T> => {
	const body = options.body != null ? JSON.stringify(options.body) : undefined
	const controller = new AbortController()
	const remaining = options.deadline === undefined ? Infinity : options.deadline - Date.now()
	const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? 5000, remaining))
	const abort = () => controller.abort()
	options.signal?.addEventListener('abort', abort, { once: true })
	if (options.signal?.aborted || timeoutMs <= 0) controller.abort()
	const timer = setTimeout(abort, timeoutMs)
	try {
		const response = await fetch(url, {
			method: options.method ?? 'GET',
			signal: controller.signal,
			body,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
		})
		return await read(response)
	} catch (error) {
		if (!controller.signal.aborted && !isAbortError(error)) throw error
		if (options.signal?.aborted) throw new HttpRequestAbortedError()
		throw new HttpTimeoutError(timeoutMs)
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener('abort', abort)
	}
}

const isAbortError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object' || !('name' in error)) {
		return false
	}

	return (error as { name: string }).name === 'AbortError'
}

const extractErrorDetail = async (response: Response): Promise<{ message: string; code?: string } | null> => {
	try {
		const body = await response.json()
		if (body && typeof body === 'object' && 'error' in body) {
			const error = (body as { error?: unknown }).error
			if (error && typeof error === 'object' && 'message' in error) {
				const detail = error as { message: string; code?: unknown }
				return { message: detail.message, code: typeof detail.code === 'string' ? detail.code : undefined }
			}
		}
	} catch {
		// Ignore JSON parse errors - fall back to status text
	}

	return null
}
