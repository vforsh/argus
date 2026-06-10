import {
	normalizeCookieDomainFilter,
	normalizeCookieSameSite,
	type AuthCookieClearRequest,
	type AuthCookieClearResponse,
	type AuthCookieClearScope,
	type AuthCookieDeleteRequest,
	type AuthCookieDeleteResponse,
	type AuthCookieGetRequest,
	type AuthCookieGetResponse,
	type AuthCookieSetRequest,
	type AuthCookieSetResponse,
} from '@vforsh/argus-core'
import type { RouteContext } from './types.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { clearAuthCookies, deleteAuthCookie, inspectAuthCookie, setAuthCookie } from '../../cdp/auth.js'
import { defineJsonRoute } from './defineRoute.js'

const CLEAR_SCOPES = new Set<AuthCookieClearScope>(['origin', 'site', 'domain', 'browserContext'])

const validateCookieGetPayload = (payload: AuthCookieGetRequest): string | null => {
	const identityError = validateCookieIdentityPayload(payload)
	if (identityError) {
		return identityError
	}

	if (payload.includeValue != null && typeof payload.includeValue !== 'boolean') {
		return 'includeValue must be a boolean'
	}

	return null
}

const validateCookieDeletePayload = (payload: AuthCookieDeleteRequest): string | null => validateCookieIdentityPayload(payload)

const validateCookieSetPayload = (payload: AuthCookieSetRequest): string | null => {
	if (!payload.cookie || typeof payload.cookie !== 'object') {
		return 'cookie is required'
	}

	const identityError = validateCookieIdentityPayload(payload.cookie)
	if (identityError) {
		return identityError
	}

	if (typeof payload.cookie.value !== 'string') {
		return 'cookie.value must be a string'
	}
	if (typeof payload.cookie.secure !== 'boolean') {
		return 'cookie.secure must be a boolean'
	}
	if (typeof payload.cookie.httpOnly !== 'boolean') {
		return 'cookie.httpOnly must be a boolean'
	}
	if (typeof payload.cookie.session !== 'boolean') {
		return 'cookie.session must be a boolean'
	}
	if (payload.cookie.expires !== null && (typeof payload.cookie.expires !== 'number' || !Number.isFinite(payload.cookie.expires))) {
		return 'cookie.expires must be a finite number or null'
	}
	if (payload.cookie.sameSite !== null && payload.cookie.sameSite !== undefined && typeof payload.cookie.sameSite !== 'string') {
		return 'cookie.sameSite must be a string or null'
	}
	if (payload.cookie.sameSite && !normalizeCookieSameSite(payload.cookie.sameSite)) {
		return 'cookie.sameSite must be one of: Strict, Lax, None'
	}
	if (payload.cookie.session && payload.cookie.expires != null) {
		return 'cookie.expires must be null when cookie.session is true'
	}
	if (!payload.cookie.session && payload.cookie.expires == null) {
		return 'cookie.expires is required when cookie.session is false'
	}
	if (normalizeCookieSameSite(payload.cookie.sameSite) === 'None' && !payload.cookie.secure) {
		return 'cookie.secure must be true when cookie.sameSite is None'
	}

	return null
}

const validateCookieClearPayload = (payload: AuthCookieClearRequest): string | null => {
	if (!CLEAR_SCOPES.has(payload.scope)) {
		return 'scope must be one of: origin, site, domain, browserContext'
	}
	if (payload.scope === 'domain' && !normalizeCookieDomainFilter(payload.domain)) {
		return 'domain is required when scope is "domain"'
	}
	if (payload.scope !== 'domain' && payload.domain != null && typeof payload.domain !== 'string') {
		return 'domain must be a string when provided'
	}
	if (payload.sessionOnly != null && typeof payload.sessionOnly !== 'boolean') {
		return 'sessionOnly must be a boolean'
	}
	if (payload.authOnly != null && typeof payload.authOnly !== 'boolean') {
		return 'authOnly must be a boolean'
	}

	return null
}

const createAuthCookieRoute = <TRequest, TResponse extends { ok: true }>(options: {
	endpoint: 'auth/cookies/get' | 'auth/cookies/set' | 'auth/cookies/delete' | 'auth/cookies/clear'
	validate: (payload: TRequest) => string | null
	run: (payload: TRequest, ctx: RouteContext) => Promise<TResponse>
}): WatcherRouteDefinition =>
	defineJsonRoute<TRequest, TResponse>({
		method: 'POST',
		path: `/${options.endpoint}`,
		parseBody: true,
		endpoint: options.endpoint,
		validate: options.validate,
		handle: ({ ctx, body: payload }) => options.run(payload, ctx),
	})

const validateCookieIdentityPayload = (payload: { name?: string; domain?: string; path?: string }): string | null => {
	if (typeof payload.name !== 'string' || payload.name.trim() === '') {
		return 'name is required'
	}
	if (typeof payload.domain !== 'string' || payload.domain.trim() === '') {
		return 'domain is required'
	}
	if (typeof payload.path !== 'string' || payload.path.trim() === '') {
		return 'path is required'
	}
	if (!payload.path.startsWith('/')) {
		return 'path must start with "/"'
	}

	return null
}

export const cookieGetRoute = createAuthCookieRoute<AuthCookieGetRequest, AuthCookieGetResponse>({
	endpoint: 'auth/cookies/get',
	validate: validateCookieGetPayload,
	run: (payload, ctx) =>
		inspectAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieSetRoute = createAuthCookieRoute<AuthCookieSetRequest, AuthCookieSetResponse>({
	endpoint: 'auth/cookies/set',
	validate: validateCookieSetPayload,
	run: (payload, ctx) =>
		setAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieDeleteRoute = createAuthCookieRoute<AuthCookieDeleteRequest, AuthCookieDeleteResponse>({
	endpoint: 'auth/cookies/delete',
	validate: validateCookieDeletePayload,
	run: (payload, ctx) =>
		deleteAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieClearRoute = createAuthCookieRoute<AuthCookieClearRequest, AuthCookieClearResponse>({
	endpoint: 'auth/cookies/clear',
	validate: validateCookieClearPayload,
	run: (payload, ctx) =>
		clearAuthCookies(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})
