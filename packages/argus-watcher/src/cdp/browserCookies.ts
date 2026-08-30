import type { AuthStateCookie, WatcherChrome } from '@vforsh/argus-core'
import { matchesCookieDomain, normalizeCookieDomainFilter } from '@vforsh/argus-core'
import type { CdpSourceCookieQuery } from '../sources/types.js'
import { openCdpConnection, type OneShotCdpConnection } from './connection.js'

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

		const connection = await openCdpConnection(wsUrl)
		try {
			const browserContextId = await readTargetBrowserContextId(connection, getTargetId())
			const payload = await readBrowserCookiesPayload(connection, browserContextId)
			const normalizedDomain = normalizeCookieDomainFilter(query.domain ?? null)

			return (payload.cookies ?? []).map(normalizeBrowserCookie).filter((cookie) => matchesCookieDomain(cookie.domain, normalizedDomain))
		} finally {
			connection.close()
		}
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

const readTargetBrowserContextId = async (connection: OneShotCdpConnection, targetId: string | null): Promise<string | null> => {
	if (!targetId) {
		return null
	}

	const response = await connection.sendAndWait('Target.getTargetInfo', { targetId }, { timeoutMs: 5_000 })
	return response.targetInfo?.browserContextId ?? null
}

const readBrowserCookiesPayload = async (connection: OneShotCdpConnection, browserContextId: string | null): Promise<BrowserCookiePayload> => {
	const options = { timeoutMs: 5_000 }
	try {
		return await connection.sendAndWait('Storage.getCookies', browserContextId ? { browserContextId } : {}, options)
	} catch (error) {
		if (!browserContextId || !isMissingBrowserContextError(error)) {
			throw error
		}

		// Chrome drops the context between our two calls when the target closes mid-read.
		return await connection.sendAndWait('Storage.getCookies', {}, options)
	}
}

const isMissingBrowserContextError = (error: unknown): boolean => error instanceof Error && /browser context/i.test(error.message)
