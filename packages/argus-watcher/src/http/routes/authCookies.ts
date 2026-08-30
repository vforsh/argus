import type {
	AuthCookieClearRequest,
	AuthCookieClearResponse,
	AuthCookieDeleteRequest,
	AuthCookieDeleteResponse,
	AuthCookieGetRequest,
	AuthCookieGetResponse,
	AuthCookieSetRequest,
	AuthCookieSetResponse,
	ProtocolSchema,
} from '@vforsh/argus-core'
import {
	authCookieClearRequestSchema,
	authCookieDeleteRequestSchema,
	authCookieGetRequestSchema,
	authCookieSetRequestSchema,
} from '@vforsh/argus-core'
import type { RouteContext } from './types.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { clearAuthCookies, deleteAuthCookie, inspectAuthCookie, setAuthCookie } from '../../cdp/auth.js'
import { defineJsonRoute } from './defineRoute.js'

const createAuthCookieRoute = <TRequest, TResponse extends { ok: true }>(options: {
	endpoint: 'auth/cookies/get' | 'auth/cookies/set' | 'auth/cookies/delete' | 'auth/cookies/clear'
	bodySchema: ProtocolSchema<TRequest>
	run: (payload: TRequest, ctx: RouteContext) => Promise<TResponse>
}): WatcherRouteDefinition =>
	defineJsonRoute<TRequest, TResponse>({
		method: 'POST',
		path: `/${options.endpoint}`,
		bodySchema: options.bodySchema,
		endpoint: options.endpoint,
		handle: ({ ctx, body: payload }) => options.run(payload, ctx),
	})

export const cookieGetRoute = createAuthCookieRoute<AuthCookieGetRequest, AuthCookieGetResponse>({
	endpoint: 'auth/cookies/get',
	bodySchema: authCookieGetRequestSchema,
	run: (payload, ctx) =>
		inspectAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieSetRoute = createAuthCookieRoute<AuthCookieSetRequest, AuthCookieSetResponse>({
	endpoint: 'auth/cookies/set',
	bodySchema: authCookieSetRequestSchema,
	run: (payload, ctx) =>
		setAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieDeleteRoute = createAuthCookieRoute<AuthCookieDeleteRequest, AuthCookieDeleteResponse>({
	endpoint: 'auth/cookies/delete',
	bodySchema: authCookieDeleteRequestSchema,
	run: (payload, ctx) =>
		deleteAuthCookie(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})

export const cookieClearRoute = createAuthCookieRoute<AuthCookieClearRequest, AuthCookieClearResponse>({
	endpoint: 'auth/cookies/clear',
	bodySchema: authCookieClearRequestSchema,
	run: (payload, ctx) =>
		clearAuthCookies(ctx.cdpSession, {
			...payload,
			readBrowserCookies: ctx.readBrowserCookies,
		}),
})
