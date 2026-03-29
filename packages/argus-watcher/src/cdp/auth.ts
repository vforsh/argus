import {
	AUTH_STATE_METADATA_SCHEMA_VERSION,
	compareCookieIdentity,
	cookieMatchesHost,
	getLikelySiteDomain,
	getOriginHost,
	isLikelyAuthCookieName,
	matchesCookieDomain,
	matchesCookieIdentity,
	normalizeCookieSameSite,
	normalizeCookieDomainFilter,
	type AuthCookie,
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
	type AuthStateOrigin,
	type AuthStateSnapshot,
	type AuthStateSnapshotMetadata,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import type { CdpSourceCookieQuery } from '../sources/types.js'

type RawCookie = {
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

type RawStorageEntry = {
	name?: string
	value?: string
}

type RawStateSnapshot = {
	url?: unknown
	origin?: unknown
	title?: unknown
	localStorage?: RawStorageEntry[]
	sessionStorage?: RawStorageEntry[]
}

type PageState = {
	url: string
	origin: string
	title: string | null
	localStorage: RawStorageEntry[]
	sessionStorage: RawStorageEntry[]
}

type BrowserCookieReader = (query: CdpSourceCookieQuery) => Promise<AuthStateCookie[]>
type SnapshotMetadataInput = {
	exportedAt: string
	watcherId: string
	watcherSource: 'cdp' | 'extension' | null
}

type CookieIdentityRequest = Pick<AuthCookieIdentity, 'name' | 'domain' | 'path'>

/** Read cookies for the attached page and return a normalized auth response. */
export const inspectAuthCookies = async (
	session: CdpSessionHandle,
	options: { includeValues?: boolean; domain?: string },
): Promise<AuthCookiesResponse> => {
	const { origin } = await inspectPageState(session)
	const cookies = await readCookies(session, options.includeValues === true)
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
		cookie: cookie ? normalizeStateCookieForRead(cookie, options.includeValue === true) : null,
	}
}

/** Upsert a cookie via CDP and return the stored metadata back to the caller. */
export const setAuthCookie = async (
	session: CdpSessionHandle,
	options: AuthCookieSetRequest & { readBrowserCookies?: BrowserCookieReader },
): Promise<AuthCookieSetResponse> => {
	const pageState = await inspectPageState(session)
	const cookie = normalizeSetCookieInput(options.cookie)

	const payload = (await session.sendAndWait(
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
	)) as { success?: boolean }

	if (payload.success === false) {
		throw new Error(`Chrome rejected cookie ${cookie.name}`)
	}

	const stored = await findContextCookie(session, pageState, cookie, options.readBrowserCookies)

	return {
		ok: true,
		origin: pageState.origin,
		cookie: stored ? normalizeStateCookieForRead(stored, false) : normalizeStateCookieForRead(cookie, false),
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

	await session.sendAndWait(
		'Network.deleteCookies',
		{
			name: existing.name,
			domain: existing.domain,
			path: existing.path,
		},
		{ timeoutMs: 5_000 },
	)

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
		await session.sendAndWait(
			'Network.deleteCookies',
			{
				name: cookie.name,
				domain: cookie.domain,
				path: cookie.path,
			},
			{ timeoutMs: 5_000 },
		)
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

/** Read a portable auth-state snapshot for the attached page. */
export const inspectAuthState = async (
	session: CdpSessionHandle,
	options: { domain?: string; readBrowserCookies?: BrowserCookieReader; metadata: SnapshotMetadataInput },
): Promise<AuthStateSnapshot> => {
	const pageState = await inspectPageState(session)
	const siteDomain = getLikelySiteDomain(pageState.origin)
	const normalizedDomain = normalizeCookieDomainFilter(options.domain) ?? siteDomain
	const cookies = await readStateCookies(session, options.readBrowserCookies, {
		domain: normalizedDomain,
		url: pageState.url,
	})

	return {
		ok: true,
		url: pageState.url,
		origin: pageState.origin,
		cookies,
		origins: [
			{
				origin: pageState.origin,
				localStorage: normalizeStorageEntries(pageState.localStorage),
				sessionStorage: normalizeStorageEntries(pageState.sessionStorage),
			},
		],
		metadata: buildSnapshotMetadata(pageState, cookies, siteDomain, options.metadata),
	}
}

const readCookies = async (session: CdpSessionHandle, includeValues: boolean): Promise<AuthCookie[]> => {
	const cookies = await readRawCookies(session)
	return cookies.map((cookie) => normalizeCookie(cookie, includeValues)).sort(compareCookies)
}

const readStateCookies = async (
	session: CdpSessionHandle,
	readBrowserCookiesFromSource: BrowserCookieReader | undefined,
	query: CdpSourceCookieQuery,
): Promise<AuthStateCookie[]> => {
	const [browserCookies, pageCookies] = await Promise.all([
		readBrowserCookiesFromSource ? readBrowserCookiesFromSource(query) : readBrowserCookiesFromSession(session),
		readRawCookies(session),
	])

	return mergeStateCookies(browserCookies, pageCookies.map(normalizeStateCookie))
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

const readRawCookies = async (session: CdpSessionHandle): Promise<RawCookie[]> => {
	const payload = (await session.sendAndWait('Network.getCookies', {}, { timeoutMs: 5000 })) as { cookies?: RawCookie[] }
	return payload.cookies ?? []
}

const readBrowserCookiesFromSession = async (session: CdpSessionHandle): Promise<AuthStateCookie[]> => {
	try {
		const payload = (await session.sendAndWait('Storage.getCookies', {}, { timeoutMs: 5000 })) as { cookies?: RawCookie[] }
		return (payload.cookies ?? []).map(normalizeStateCookie)
	} catch {
		// Older/partial CDP targets may not expose Storage.getCookies. Fall back to page-scoped cookies.
		return (await readRawCookies(session)).map(normalizeStateCookie)
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

const normalizeCookie = (cookie: RawCookie, includeValues: boolean): AuthCookie => {
	const value = cookie.value ?? null

	return {
		name: cookie.name ?? '',
		domain: cookie.domain ?? '',
		path: cookie.path ?? '/',
		value: includeValues ? value : undefined,
		valuePreview: value != null ? previewSecret(value) : null,
		secure: cookie.secure === true,
		httpOnly: cookie.httpOnly === true,
		session: cookie.session === true,
		expires: normalizeCookieExpires(cookie.expires),
		sameSite: cookie.sameSite ?? null,
	}
}

const normalizeStateCookieForRead = (cookie: AuthStateCookie, includeValues: boolean): AuthCookie => ({
	name: cookie.name,
	domain: cookie.domain,
	path: cookie.path,
	value: includeValues ? cookie.value : undefined,
	valuePreview: previewSecret(cookie.value),
	secure: cookie.secure,
	httpOnly: cookie.httpOnly,
	session: cookie.session,
	expires: cookie.expires,
	sameSite: normalizeCookieSameSite(cookie.sameSite),
})

const normalizeStateCookie = (cookie: RawCookie): AuthStateCookie => ({
	name: cookie.name ?? '',
	value: cookie.value ?? '',
	domain: cookie.domain ?? '',
	path: cookie.path ?? '/',
	secure: cookie.secure === true,
	httpOnly: cookie.httpOnly === true,
	session: cookie.session === true,
	expires: normalizeCookieExpires(cookie.expires),
	sameSite: normalizeCookieSameSite(cookie.sameSite),
})

const normalizeSetCookieInput = (cookie: AuthStateCookie): AuthStateCookie => ({
	name: cookie.name,
	value: cookie.value,
	domain: cookie.domain,
	path: cookie.path,
	secure: cookie.secure,
	httpOnly: cookie.httpOnly,
	session: cookie.session,
	expires: cookie.session ? null : cookie.expires,
	sameSite: normalizeCookieSameSite(cookie.sameSite),
})

const normalizeCookieExpires = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * We still read the live page origin so CLI-side `--for-origin` filtering can distinguish
 * first-party cookies from cross-site noise without duplicating URL resolution logic.
 */
const inspectPageState = async (session: CdpSessionHandle): Promise<PageState> => {
	const payload = (await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: `(() => {
				try {
					const url = String(location.href)
					const origin = new URL(url).origin
					const collectStorage = (storage) => {
						const entries = []
						for (let index = 0; index < storage.length; index++) {
							const key = storage.key(index)
							if (key == null) {
								continue
							}
							entries.push({ name: key, value: storage.getItem(key) ?? '' })
						}
						entries.sort((left, right) => left.name.localeCompare(right.name))
						return entries
					}

					return {
						url,
						origin,
						title: typeof document.title === 'string' && document.title.trim() ? document.title.trim() : null,
						localStorage: collectStorage(localStorage),
						sessionStorage: collectStorage(sessionStorage),
					}
				} catch {
					throw new Error('Cannot determine origin: page is on a non-http URL (e.g., about:blank)')
				}
			})()`,
			awaitPromise: false,
			returnByValue: true,
		},
		{ timeoutMs: 5000 },
	)) as {
		result?: { value?: unknown }
		exceptionDetails?: { text?: string; exception?: { description?: string } }
	}

	if (payload.exceptionDetails) {
		throw new Error(payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'Failed to inspect page auth state')
	}

	return normalizePageState(payload.result?.value)
}

const previewSecret = (value: string): string => {
	if (value.length <= 8) {
		return '*'.repeat(value.length)
	}

	return `${value.slice(0, 4)}...${value.slice(-4)}`
}

const compareCookies = (a: AuthCookie, b: AuthCookie): number => compareCookieIdentity(a, b)

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

const normalizePageState = (value: unknown): PageState => {
	const snapshot = typeof value === 'object' && value ? (value as RawStateSnapshot) : {}
	const url = typeof snapshot.url === 'string' ? snapshot.url : ''
	const origin = typeof snapshot.origin === 'string' ? snapshot.origin : ''

	if (!url || !origin) {
		throw new Error('Failed to inspect page auth state')
	}

	return {
		url,
		origin,
		title: typeof snapshot.title === 'string' && snapshot.title.trim() ? snapshot.title : null,
		localStorage: Array.isArray(snapshot.localStorage) ? snapshot.localStorage : [],
		sessionStorage: Array.isArray(snapshot.sessionStorage) ? snapshot.sessionStorage : [],
	}
}

const buildSnapshotMetadata = (
	pageState: Pick<PageState, 'title' | 'url' | 'origin'>,
	cookies: AuthStateCookie[],
	siteDomain: string | null,
	input: SnapshotMetadataInput,
): AuthStateSnapshotMetadata => ({
	schemaVersion: AUTH_STATE_METADATA_SCHEMA_VERSION,
	exportedAt: input.exportedAt,
	source: {
		watcherId: input.watcherId,
		watcherSource: input.watcherSource,
	},
	page: {
		title: pageState.title,
		siteDomain,
	},
	capture: {
		cookieCount: cookies.length,
	},
	authHints: {
		authCookieNames: Array.from(new Set(cookies.map((cookie) => cookie.name).filter(isLikelyAuthCookieName))).sort((a, b) => a.localeCompare(b)),
	},
	recommendedStartupUrl: pageState.url,
})

const normalizeStorageEntries = (entries: RawStorageEntry[]): AuthStateOrigin['localStorage'] =>
	entries
		.filter((entry) => typeof entry?.name === 'string')
		.map((entry) => ({
			name: entry.name ?? '',
			value: typeof entry.value === 'string' ? entry.value : '',
		}))
