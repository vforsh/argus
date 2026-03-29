const AUTH_COOKIE_PATTERNS = [/session/i, /\bsid\b/i, /connect\.sid/i, /next-auth/i, /auth/i, /token/i, /jwt/i, /access/i, /refresh/i]
const TRACKING_COOKIE_PATTERNS = [/^_ga/i, /^_gid$/i, /^_ym/i, /^_fbp$/i, /^_hj/i, /^amplitude/i, /^mp_/i]

type CookieIdentityLike = {
	name: string
	domain: string
	path: string
}

/** Normalize a cookie-domain filter so comparisons stay case-insensitive and dot-agnostic. */
export const normalizeCookieDomainFilter = (domain: string | undefined | null): string | null => {
	if (!domain) {
		return null
	}

	const normalized = normalizeCookieDomain(domain)
	return normalized || null
}

/** Match a cookie domain against a normalized suffix filter. */
export const matchesCookieDomain = (cookieDomain: string, domain: string | null): boolean => {
	if (!domain) {
		return true
	}

	const normalizedDomain = normalizeCookieDomain(cookieDomain)
	return normalizedDomain === domain || normalizedDomain.endsWith(`.${domain}`)
}

/** Whether a cookie domain is sent for the given host. */
export const cookieMatchesHost = (cookieDomain: string, host: string): boolean => {
	const normalizedDomain = normalizeCookieDomain(cookieDomain)
	const normalizedHost = normalizeCookieDomain(host)
	if (!normalizedDomain || !normalizedHost) {
		return false
	}

	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
}

/** Compare cookie identities using case-insensitive, dot-agnostic domain matching. */
export const matchesCookieIdentity = (left: CookieIdentityLike, right: CookieIdentityLike): boolean =>
	left.name === right.name && left.path === right.path && normalizeCookieDomain(left.domain) === normalizeCookieDomain(right.domain)

/** Stable sort order for cookie identities. */
export const compareCookieIdentity = (left: CookieIdentityLike, right: CookieIdentityLike): number =>
	normalizeCookieDomain(left.domain).localeCompare(normalizeCookieDomain(right.domain)) ||
	left.path.localeCompare(right.path) ||
	left.name.localeCompare(right.name)

/** Return the hostname part of an origin, or null when the string is not a valid origin. */
export const getOriginHost = (origin: string): string | null => {
	try {
		return new URL(origin).hostname
	} catch {
		return null
	}
}

/** Whether a cookie name looks auth-related enough to hint at a session/token role. */
export const isLikelyAuthCookieName = (name: string): boolean => AUTH_COOKIE_PATTERNS.some((pattern) => pattern.test(name))

/** Whether a cookie name is likely just analytics/tracking noise. */
export const isTrackingCookieName = (name: string): boolean => TRACKING_COOKIE_PATTERNS.some((pattern) => pattern.test(name))

/** Normalize SameSite values to the CDP-friendly casing Argus uses internally. */
export const normalizeCookieSameSite = (value: string | null | undefined): 'Strict' | 'Lax' | 'None' | null => {
	if (value == null) {
		return null
	}

	switch (value.trim().toLowerCase()) {
		case '':
			return null
		case 'strict':
			return 'Strict'
		case 'lax':
			return 'Lax'
		case 'none':
			return 'None'
		default:
			return null
	}
}

/**
 * Best-effort site-domain heuristic for broadening auth export beyond the current host.
 * This intentionally keeps sibling subdomains such as `auth.example.com` while avoiding
 * unrelated browser cookies in other sites. IPs and localhost stay host-scoped.
 */
export const getLikelySiteDomain = (hostOrOrigin: string): string | null => {
	const host = getOriginHost(hostOrOrigin) ?? normalizeCookieDomain(hostOrOrigin)
	if (!host) {
		return null
	}

	if (host === 'localhost' || isIpAddress(host)) {
		return host
	}

	const parts = host.split('.').filter(Boolean)
	if (parts.at(-1) === 'localhost') {
		return 'localhost'
	}
	if (parts.length <= 2) {
		return host
	}

	return parts.slice(-2).join('.')
}

const normalizeCookieDomain = (domain: string): string => domain.trim().toLowerCase().replace(/^\./, '')

const isIpAddress = (value: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':')
