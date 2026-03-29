import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { clearAuthCookies, inspectAuthCookie, setAuthCookie } from '../src/cdp/auth.js'

describe('auth cookie operations', () => {
	it('finds one cookie by exact identity with dot-agnostic domain matching', async () => {
		const session = createCookieSessionStub(async (method) => {
			switch (method) {
				case 'Runtime.evaluate':
					return pageState('https://app.example.com/')
				case 'Storage.getCookies':
					return {
						cookies: [
							{
								name: 'session',
								value: 'secret1234',
								domain: '.Example.com',
								path: '/',
								secure: true,
								httpOnly: true,
								session: false,
								expires: 1700000000,
								sameSite: 'Lax',
							},
						],
					}
				case 'Network.getCookies':
					return { cookies: [] }
				default:
					throw new Error(`Unexpected CDP method: ${method}`)
			}
		})

		const response = await inspectAuthCookie(session, {
			name: 'session',
			domain: 'example.com',
			path: '/',
		})

		expect(response.origin).toBe('https://app.example.com')
		expect(response.cookie).toMatchObject({
			name: 'session',
			domain: '.Example.com',
			path: '/',
			value: undefined,
			valuePreview: 'secr...1234',
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
		})
	})

	it('clears only auth-looking cookies that apply to the current origin host', async () => {
		const deleted: Array<Record<string, unknown>> = []
		const session = createCookieSessionStub(async (method, params) => {
			switch (method) {
				case 'Runtime.evaluate':
					return pageState('https://app.example.com/dashboard')
				case 'Storage.getCookies':
					return {
						cookies: [
							{
								name: 'session',
								value: 'a',
								domain: '.example.com',
								path: '/',
								secure: true,
								httpOnly: true,
								session: false,
								expires: 170,
								sameSite: 'Lax',
							},
							{
								name: 'sid',
								value: 'b',
								domain: 'app.example.com',
								path: '/',
								secure: false,
								httpOnly: false,
								session: true,
								expires: null,
								sameSite: 'Strict',
							},
							{
								name: 'theme',
								value: 'dark',
								domain: '.example.com',
								path: '/',
								secure: false,
								httpOnly: false,
								session: true,
								expires: null,
								sameSite: 'Lax',
							},
							{
								name: 'session',
								value: 'c',
								domain: 'auth.example.com',
								path: '/',
								secure: true,
								httpOnly: true,
								session: false,
								expires: 170,
								sameSite: 'Lax',
							},
						],
					}
				case 'Network.getCookies':
					return { cookies: [] }
				case 'Network.deleteCookies':
					deleted.push(params ?? {})
					return {}
				default:
					throw new Error(`Unexpected CDP method: ${method}`)
			}
		})

		const response = await clearAuthCookies(session, {
			scope: 'origin',
			authOnly: true,
		})

		expect(response.scope).toBe('origin')
		expect(response.scopeValue).toBe('app.example.com')
		expect(response.cleared).toBe(2)
		expect(response.cookies).toEqual([
			{ name: 'sid', domain: 'app.example.com', path: '/' },
			{ name: 'session', domain: '.example.com', path: '/' },
		])
		expect(deleted).toEqual([
			{ name: 'sid', domain: 'app.example.com', path: '/' },
			{ name: 'session', domain: '.example.com', path: '/' },
		])
	})

	it('upserts cookies with normalized SameSite metadata', async () => {
		const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
		const session = createCookieSessionStub(async (method, params) => {
			calls.push({ method, params })
			switch (method) {
				case 'Runtime.evaluate':
					return pageState('https://app.example.com/')
				case 'Network.setCookie':
					return { success: true }
				case 'Storage.getCookies':
					return {
						cookies: [
							{
								name: 'preview',
								value: '1',
								domain: 'app.example.com',
								path: '/',
								secure: true,
								httpOnly: false,
								session: true,
								expires: null,
								sameSite: 'None',
							},
						],
					}
				case 'Network.getCookies':
					return { cookies: [] }
				default:
					throw new Error(`Unexpected CDP method: ${method}`)
			}
		})

		const response = await setAuthCookie(session, {
			cookie: {
				name: 'preview',
				value: '1',
				domain: 'app.example.com',
				path: '/',
				secure: true,
				httpOnly: false,
				session: true,
				expires: null,
				sameSite: 'none',
			},
		})

		expect(response.cookie.sameSite).toBe('None')
		expect(calls).toContainEqual({
			method: 'Network.setCookie',
			params: {
				name: 'preview',
				value: '1',
				domain: 'app.example.com',
				path: '/',
				secure: true,
				httpOnly: false,
				sameSite: 'None',
				expires: undefined,
			},
		})
	})
})

const createCookieSessionStub = (sendAndWait: (method: string, params?: Record<string, unknown>) => Promise<unknown>): CdpSessionHandle => ({
	isAttached: () => true,
	sendAndWait,
	onEvent: () => () => {},
	getTargetContext: () => ({ kind: 'page' }),
})

const pageState = (url: string) => ({
	result: {
		value: {
			url,
			origin: new URL(url).origin,
			title: null,
			localStorage: [],
			sessionStorage: [],
		},
	},
})
