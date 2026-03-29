import type { AuthStateCookie, WatcherChrome } from '@vforsh/argus-core'
import { matchesCookieDomain, normalizeCookieDomainFilter } from '@vforsh/argus-core'
import type { CdpSourceCookieQuery } from '../sources/types.js'

type ChromeVersionResponse = {
	webSocketDebuggerUrl?: string
}

type BrowserCookiePayload = {
	cookies?: RawBrowserCookie[]
}

type RawBrowserCookie = {
	name?: string
	value?: string
	domain?: string
	path?: string
	secure?: boolean
	httpOnly?: boolean
	session?: boolean
	expires?: number
	sameSite?: string
}

type WebSocketLike = {
	addEventListener: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	removeEventListener?: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	send: (data: string) => void
	close: () => void
}

type WebSocketCtor = new (url: string) => WebSocketLike
const TARGET_INFO_REQUEST_ID = 1
const STORAGE_GET_COOKIES_REQUEST_ID = 2
const STORAGE_GET_COOKIES_FALLBACK_REQUEST_ID = 3

/**
 * Browser-target cookies are the only reliable way to capture sibling subdomain auth in CDP mode.
 * Page-target `Network.getCookies` only sees the current document's request scope.
 */
export const createCdpBrowserCookieReader =
	(chrome: WatcherChrome, getTargetId: () => string | null) =>
	async (query: CdpSourceCookieQuery): Promise<AuthStateCookie[]> => {
		const host = chrome.host ?? '127.0.0.1'
		const port = chrome.port ?? 9222
		const version = await fetchChromeVersion(host, port)
		const wsUrl = version.webSocketDebuggerUrl
		if (!wsUrl) {
			throw new Error(`Chrome browser websocket missing at ${host}:${port}`)
		}

		const browserContextId = await readTargetBrowserContextId(wsUrl, getTargetId())
		const payload = await readBrowserCookiesPayload(wsUrl, browserContextId)
		const normalizedDomain = normalizeCookieDomainFilter(query.domain ?? null)

		return (payload.cookies ?? []).map(normalizeBrowserCookie).filter((cookie) => matchesCookieDomain(cookie.domain, normalizedDomain))
	}

const fetchChromeVersion = async (host: string, port: number): Promise<ChromeVersionResponse> => {
	const response = await fetch(`http://${host}:${port}/json/version`, {
		signal: AbortSignal.timeout(5_000),
	})
	if (!response.ok) {
		throw new Error(`Chrome version endpoint failed with ${response.status}`)
	}
	return (await response.json()) as ChromeVersionResponse
}

const normalizeBrowserCookie = (cookie: RawBrowserCookie): AuthStateCookie => ({
	name: cookie.name ?? '',
	value: cookie.value ?? '',
	domain: cookie.domain ?? '',
	path: cookie.path ?? '/',
	secure: cookie.secure === true,
	httpOnly: cookie.httpOnly === true,
	session: cookie.session === true,
	expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : null,
	sameSite: cookie.sameSite ?? null,
})

const readTargetBrowserContextId = async (wsUrl: string, targetId: string | null): Promise<string | null> => {
	if (!targetId) {
		return null
	}

	const response = await sendBrowserCommand<{ targetInfo?: { browserContextId?: string } }>(wsUrl, {
		id: TARGET_INFO_REQUEST_ID,
		method: 'Target.getTargetInfo',
		params: { targetId },
	})

	return response.targetInfo?.browserContextId ?? null
}

const readBrowserCookiesPayload = async (wsUrl: string, browserContextId: string | null): Promise<BrowserCookiePayload> => {
	try {
		return await sendBrowserCommand<BrowserCookiePayload>(wsUrl, {
			id: STORAGE_GET_COOKIES_REQUEST_ID,
			method: 'Storage.getCookies',
			params: browserContextId ? { browserContextId } : undefined,
		})
	} catch (error) {
		if (!browserContextId || !isMissingBrowserContextError(error)) {
			throw error
		}

		return await sendBrowserCommand<BrowserCookiePayload>(wsUrl, {
			id: STORAGE_GET_COOKIES_FALLBACK_REQUEST_ID,
			method: 'Storage.getCookies',
		})
	}
}

const isMissingBrowserContextError = (error: unknown): boolean => error instanceof Error && /browser context/i.test(error.message)

const sendBrowserCommand = async <T>(
	wsUrl: string,
	payload: {
		id: number
		method: string
		params?: Record<string, unknown>
	},
	timeoutMs = 5_000,
): Promise<T> => {
	const WebSocketConstructor = getWebSocketCtor()
	if (!WebSocketConstructor) {
		throw new Error('WebSocket unavailable. Node 18+ required.')
	}

	const ws = new WebSocketConstructor(wsUrl)

	return await new Promise<T>((resolve, reject) => {
		let settled = false
		const timer = setTimeout(() => finish(undefined, new Error(`CDP command timed out after ${timeoutMs}ms`)), timeoutMs)

		const cleanup = (): void => {
			clearTimeout(timer)
			ws.removeEventListener?.('open', onOpen)
			ws.removeEventListener?.('message', onMessage)
			ws.removeEventListener?.('error', onError)
			ws.removeEventListener?.('close', onClose)
		}

		const finish = (result?: T, error?: Error): void => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			try {
				ws.close()
			} catch {}
			if (error) {
				reject(error)
				return
			}
			resolve(result as T)
		}

		const onOpen = (): void => {
			try {
				ws.send(JSON.stringify(payload))
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onMessage = (event: { data?: unknown }): void => {
			const text = toMessageText(event.data)
			if (!text) {
				return
			}

			try {
				const message = JSON.parse(text) as { id?: number; result?: T; error?: { message?: string } }
				if (message.id !== payload.id) {
					return
				}
				if (message.error?.message) {
					finish(undefined, new Error(message.error.message))
					return
				}
				finish(message.result as T)
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onError = (): void => {
			finish(undefined, new Error('WebSocket error'))
		}

		const onClose = (): void => {
			finish(undefined, new Error('WebSocket closed before response'))
		}

		ws.addEventListener('open', onOpen)
		ws.addEventListener('message', onMessage)
		ws.addEventListener('error', onError)
		ws.addEventListener('close', onClose)
	})
}

const getWebSocketCtor = (): WebSocketCtor | null => {
	const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
	return ctor ?? null
}

const toMessageText = (data: unknown): string | null => {
	if (typeof data === 'string') {
		return data
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8')
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8')
	}
	return null
}
