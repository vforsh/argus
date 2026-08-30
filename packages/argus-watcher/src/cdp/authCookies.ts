import {
	compareCookieIdentity,
	cookieMatchesHost,
	getLikelySiteDomain,
	getOriginHost,
	isLikelyAuthCookieName,
	matchesCookieDomain,
	matchesCookieIdentity,
	normalizeCookieDomainFilter,
	type AuthCookieClearRequest,
	type AuthCookieClearResponse,
	type AuthCookieDeleteRequest,
	type AuthCookieDeleteResponse,
	type AuthCookieGetRequest,
	type AuthCookieGetResponse,
	type AuthCookieIdentity,
	type AuthCookiesResponse,
	type AuthCookieSetRequest,
	type AuthCookieSetResponse,
	type AuthStateCookie,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import type { CdpSourceCookieQuery } from '../sources/types.js'
import { inspectPageState, type PageState } from './authPageState.js'
import { normalizeSetCookieInput, toAuthCookie, toStateCookie, type RawCookie } from './authCookieShapes.js'

/** Reads browser-scoped cookies from a source that can do better than page-scoped CDP. */
export type BrowserCookieReader = (query: CdpSourceCookieQuery) => Promise<AuthStateCookie[]>

type CookieIdentityRequest = Pick<AuthCookieIdentity, 'name' | 'domain' | 'path'>

/** Read cookies for the attached page and return a normalized auth response. */
export const inspectAuthCookies = async (
	session: CdpSessionHandle,
	options: { includeValues?: boolean; domain?: string },
): Promise<AuthCookiesResponse> => {
	const { origin } = await inspectPageState(session)
	const raw = await readRawCookies(session)
	const cookies = raw.map((cookie) => toAuthCookie(toStateCookie(cookie), options.includeValues === true)).sort(compareCookieIdentity)
	const normalizedDomain = normalizeCookieDomainFilter(options.domain)

	return {
		ok: true,
		origin,
		cookies: cookies.filter((cookie) => matchesCookieDomain(cookie.domain, normalizedDomain)),
	}
}

/** Read a single cookie by exact identity from the current browser context. */
export const inspectAuthCookie = async (
	session: CdpSessionHandle,
	options: AuthCookieGetRequest & { readBrowserCookies?: BrowserCookieReader },
): Promise<AuthCookieGetResponse> => {
	const pageState = await inspectPageState(session)
	const cookie = await findContextCookie(session, pageState, options, options.readBrowserCookies)

	return {
		ok: true,
		origin: pageState.origin,
		cookie: cookie ? toAuthCookie(cookie, options.includeValue === true) : null,
	}
}

/** Upsert a cookie via CDP and return the stored metadata back to the caller. */
export const setAuthCookie = async (
	session: CdpSessionHandle,
	options: AuthCookieSetRequest & { readBrowserCookies?: BrowserCookieReader },
): Promise<AuthCookieSetResponse> => {
	const pageState = await inspectPageState(session)
	const cookie = normalizeSetCookieInput(options.cookie)

	const payload = await session.sendAndWait(
		'Network.setCookie',
		{
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			sameSite: cookie.sameSite ?? undefined,
			expires: cookie.session ? undefined : (cookie.expires ?? undefined),
		},
		{ timeoutMs: 5_000 },
	)

	if (payload.success === false) {
		throw new Error(`Chrome rejected cookie ${cookie.name}`)
	}

	const stored = await findContextCookie(session, pageState, cookie, options.readBrowserCookies)

	return {
		ok: true,
		origin: pageState.origin,
		cookie: toAuthCookie(stored ?? cookie, false),
	}
}

/** Delete a cookie by exact identity from the current browser context. */
export const deleteAuthCookie = async (
	session: CdpSessionHandle,
	options: AuthCookieDeleteRequest & { readBrowserCookies?: BrowserCookieReader },
): Promise<AuthCookieDeleteResponse> => {
	const pageState = await inspectPageState(session)
	const existing = await findContextCookie(session, pageState, options, options.readBrowserCookies)

	if (!existing) {
		return {
			ok: true,
			origin: pageState.origin,
			deleted: false,
			cookie: toCookieIdentity(options),
		}
	}

	await deleteCookie(session, existing)

	return {
		ok: true,
		origin: pageState.origin,
		deleted: true,
		cookie: toCookieIdentity(existing),
	}
}

/** Delete cookies from the current browser context using an explicit scope + filter set. */
export const clearAuthCookies = async (
	session: CdpSessionHandle,
	options: AuthCookieClearRequest & { readBrowserCookies?: BrowserCookieReader },
): Promise<AuthCookieClearResponse> => {
	const pageState = await inspectPageState(session)
	const cookies = await readStateCookies(session, options.readBrowserCookies, { url: pageState.url })
	const matcher = createClearCookieMatcher(pageState, options)
	const targets = cookies.filter((cookie) => matcher(cookie) && matchesCookieClearFilters(cookie, options))

	for (const cookie of targets) {
		await deleteCookie(session, cookie)
	}

	return {
		ok: true,
		origin: pageState.origin,
		scope: options.scope,
		scopeValue: resolveClearScopeValue(pageState, options),
		sessionOnly: options.sessionOnly === true,
		authOnly: options.authOnly === true,
		cleared: targets.length,
		cookies: targets.map((cookie) => toCookieIdentity(cookie)).sort(compareCookieIdentity),
	}
}

/**
 * Read every cookie visible to the attached context, merged and domain-filtered.
 *
 * Prefers the source's browser-scoped reader (the extension transport can see more than the page
 * can) and merges in page-scoped cookies, keyed by identity so the browser copy wins.
 */
export const readStateCookies = async (
	session: CdpSessionHandle,
	readBrowserCookiesFromSource: BrowserCookieReader | undefined,
	query: CdpSourceCookieQuery,
): Promise<AuthStateCookie[]> => {
	const [browserCookies, pageCookies] = await Promise.all([
		readBrowserCookiesFromSource ? readBrowserCookiesFromSource(query) : readBrowserCookiesFromSession(session),
		readRawCookies(session),
	])

	return mergeStateCookies(browserCookies, pageCookies.map(toStateCookie))
		.filter((cookie) => matchesCookieDomain(cookie.domain, query.domain ?? null))
		.sort(compareCookieIdentity)
}

const findContextCookie = async (
	session: CdpSessionHandle,
	pageState: Pick<PageState, 'url'>,
	identity: CookieIdentityRequest,
	readBrowserCookiesFromSource?: BrowserCookieReader,
): Promise<AuthStateCookie | null> => {
	const cookies = await readStateCookies(session, readBrowserCookiesFromSource, { url: pageState.url })
	return cookies.find((cookie) => matchesCookieIdentity(cookie, identity)) ?? null
}

const deleteCookie = async (session: CdpSessionHandle, cookie: Pick<AuthStateCookie, 'name' | 'domain' | 'path'>): Promise<void> => {
	await session.sendAndWait('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path }, { timeoutMs: 5_000 })
}

const readRawCookies = async (session: CdpSessionHandle): Promise<RawCookie[]> => {
	const payload = await session.sendAndWait('Network.getCookies', {}, { timeoutMs: 5000 })
	return payload.cookies ?? []
}

const readBrowserCookiesFromSession = async (session: CdpSessionHandle): Promise<AuthStateCookie[]> => {
	try {
		const payload = await session.sendAndWait('Storage.getCookies', {}, { timeoutMs: 5000 })
		return (payload.cookies ?? []).map(toStateCookie)
	} catch {
		// Older/partial CDP targets may not expose Storage.getCookies. Fall back to page-scoped cookies.
		return (await readRawCookies(session)).map(toStateCookie)
	}
}

const mergeStateCookies = (...groups: AuthStateCookie[][]): AuthStateCookie[] => {
	const merged = new Map<string, AuthStateCookie>()
	for (const group of groups) {
		for (const cookie of group) {
			merged.set(serializeCookieIdentity(cookie), cookie)
		}
	}
	return Array.from(merged.values())
}

const toCookieIdentity = (cookie: { domain?: string; path?: string; name?: string }): AuthCookieIdentity => ({
	name: cookie.name ?? '',
	domain: cookie.domain ?? '',
	path: cookie.path ?? '/',
})

const serializeCookieIdentity = (cookie: { domain?: string; path?: string; name?: string }): string =>
	`${normalizeCookieDomainFilter(cookie.domain ?? '') ?? ''}\t${cookie.path ?? '/'}\t${cookie.name ?? ''}`

const createClearCookieMatcher = (
	pageState: Pick<PageState, 'origin'>,
	options: Pick<AuthCookieClearRequest, 'scope' | 'domain'>,
): ((cookie: AuthStateCookie) => boolean) => {
	switch (options.scope) {
		case 'browserContext':
			return () => true
		case 'domain': {
			const normalizedDomain = normalizeCookieDomainFilter(options.domain)
			return (cookie) => matchesCookieDomain(cookie.domain, normalizedDomain)
		}
		case 'site': {
			const siteDomain = getLikelySiteDomain(pageState.origin)
			if (!siteDomain) {
				throw new Error(`Cannot determine site domain from ${pageState.origin}`)
			}
			return (cookie) => matchesCookieDomain(cookie.domain, siteDomain)
		}
		case 'origin': {
			const host = getOriginHost(pageState.origin)
			if (!host) {
				throw new Error(`Cannot determine origin host from ${pageState.origin}`)
			}
			return (cookie) => cookieMatchesHost(cookie.domain, host)
		}
	}
}

const matchesCookieClearFilters = (cookie: AuthStateCookie, options: Pick<AuthCookieClearRequest, 'sessionOnly' | 'authOnly'>): boolean => {
	if (options.sessionOnly && !cookie.session) {
		return false
	}
	if (options.authOnly && !isLikelyAuthCookieName(cookie.name)) {
		return false
	}
	return true
}

const resolveClearScopeValue = (pageState: Pick<PageState, 'origin'>, options: Pick<AuthCookieClearRequest, 'scope' | 'domain'>): string | null => {
	switch (options.scope) {
		case 'browserContext':
			return null
		case 'domain':
			return normalizeCookieDomainFilter(options.domain)
		case 'site':
			return getLikelySiteDomain(pageState.origin)
		case 'origin':
			return getOriginHost(pageState.origin)
	}
}
