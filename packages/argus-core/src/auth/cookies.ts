const AUTH_COOKIE_PATTERNS = [/session/i, /\bsid\b/i, /connect\.sid/i, /next-auth/i, /auth/i, /token/i, /jwt/i, /access/i, /refresh/i]
const TRACKING_COOKIE_PATTERNS = [/^_ga/i, /^_gid$/i, /^_ym/i, /^_fbp$/i, /^_hj/i, /^amplitude/i, /^mp_/i]

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

const normalizeCookieDomain = (domain: string): string => domain.trim().toLowerCase().replace(/^\./, '')
