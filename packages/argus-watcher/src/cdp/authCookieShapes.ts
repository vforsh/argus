import { normalizeCookieSameSite, type AuthCookie, type AuthStateCookie } from '@vforsh/argus-core'
import { redactToken } from './redaction.js'

/** A cookie as CDP reports it, before any normalization. */
export type RawCookie = {
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
 * Normalize a CDP cookie into the portable snapshot shape.
 *
 * The single raw → normalized step. There used to be four overlapping normalizers here, and two
 * different routes to the same `AuthCookie` depending on which read API a caller happened to hit;
 * every read now goes raw → {@link AuthStateCookie} → {@link toAuthCookie}.
 */
export const toStateCookie = (cookie: RawCookie): AuthStateCookie => ({
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

/** Project a snapshot cookie onto the read shape, revealing the value only when asked. */
export const toAuthCookie = (cookie: AuthStateCookie, includeValue: boolean): AuthCookie => ({
	name: cookie.name,
	domain: cookie.domain,
	path: cookie.path,
	value: includeValue ? cookie.value : undefined,
	valuePreview: redactToken(cookie.value),
	secure: cookie.secure,
	httpOnly: cookie.httpOnly,
	session: cookie.session,
	expires: cookie.expires,
	sameSite: normalizeCookieSameSite(cookie.sameSite),
})

/** Apply the set-cookie input rule: a session cookie never carries an expiry. */
export const normalizeSetCookieInput = (cookie: AuthStateCookie): AuthStateCookie => ({
	...cookie,
	expires: cookie.session ? null : normalizeCookieExpires(cookie.expires),
	sameSite: normalizeCookieSameSite(cookie.sameSite),
})

const normalizeCookieExpires = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
