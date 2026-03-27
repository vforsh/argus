import type { AuthCookie, AuthCookiesResponse } from '@vforsh/argus-core'
import { matchesCookieDomain, normalizeCookieDomainFilter } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

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

/** Read cookies for the attached page and return a normalized auth response. */
export const inspectAuthCookies = async (
	session: CdpSessionHandle,
	options: { includeValues?: boolean; domain?: string },
): Promise<AuthCookiesResponse> => {
	const [origin, cookies] = await Promise.all([capturePageOrigin(session), readCookies(session, options.includeValues === true)])
	const normalizedDomain = normalizeCookieDomainFilter(options.domain)

	return {
		ok: true,
		origin,
		cookies: cookies.filter((cookie) => matchesCookieDomain(cookie.domain, normalizedDomain)),
	}
}

const readCookies = async (session: CdpSessionHandle, includeValues: boolean): Promise<AuthCookie[]> => {
	const payload = (await session.sendAndWait('Network.getCookies', {}, { timeoutMs: 5000 })) as { cookies?: RawCookie[] }
	const cookies = payload.cookies ?? []

	return cookies.map((cookie) => normalizeCookie(cookie, includeValues)).sort(compareCookies)
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
		expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : null,
		sameSite: cookie.sameSite ?? null,
	}
}

/**
 * We still read the live page origin so CLI-side `--for-origin` filtering can distinguish
 * first-party cookies from cross-site noise without duplicating URL resolution logic.
 */
const capturePageOrigin = async (session: CdpSessionHandle): Promise<string> => {
	const payload = (await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: `(() => {
				try {
					return new URL(location.href).origin
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
		throw new Error(payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'Failed to inspect page auth cookies')
	}

	return String(payload.result?.value ?? '')
}

const previewSecret = (value: string): string => {
	if (value.length <= 8) {
		return '*'.repeat(value.length)
	}

	return `${value.slice(0, 4)}...${value.slice(-4)}`
}

const compareCookies = (a: AuthCookie, b: AuthCookie): number =>
	a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name)
