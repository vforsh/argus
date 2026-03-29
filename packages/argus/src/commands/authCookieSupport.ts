import {
	cookieMatchesHost,
	getOriginHost,
	isTrackingCookieName,
	normalizeCookieSameSite,
	type AuthCookie,
	type AuthCookiesResponse,
	type AuthStateCookie,
} from '@vforsh/argus-core'
import { writeFile } from 'node:fs/promises'
import type { Output } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

type CookieFetchInput = {
	domain?: string
	includeValues?: boolean
}

type CookieClearScope = 'origin' | 'site' | 'domain' | 'browserContext'

type CookieFilterOptions = {
	sessionOnly?: boolean
	httpOnly?: boolean
	secure?: boolean
	forOrigin?: boolean
	excludeTracking?: boolean
}

type CookieSetInput = {
	name: string
	value: string
	domain: string
	path: string
	secure?: boolean
	httpOnly?: boolean
	sameSite?: string
	expires?: string
	session?: boolean
}

const COOKIE_EXPORT_FORMATS = new Set(['netscape', 'json', 'header'])

export const fetchAuthCookies = async (id: string | undefined, input: CookieFetchInput, output: Output): Promise<AuthCookiesResponse | null> => {
	const result = await requestWatcherJson<AuthCookiesResponse>({
		id,
		path: '/auth/cookies',
		query: buildCookieQuery(input),
		timeoutMs: 10_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	return result.data
}

export const normalizeCookieIdentityInput = (
	input: { name: string; domain: string; path: string },
	output: Output,
): { name: string; domain: string; path: string } | null => {
	const name = input.name.trim()
	const domain = input.domain.trim()
	const path = input.path.trim()

	if (!name) {
		return writeCookieInputError(output, 'name is required')
	}
	if (!domain) {
		return writeCookieInputError(output, 'domain is required')
	}
	if (!path) {
		return writeCookieInputError(output, 'path is required')
	}
	if (!path.startsWith('/')) {
		return writeCookieInputError(output, 'path must start with "/"')
	}

	return { name, domain, path }
}

export const parseCookieSetInput = (input: CookieSetInput, output: Output): AuthStateCookie | null => {
	const identity = normalizeCookieIdentityInput(input, output)
	if (!identity) {
		return null
	}

	const sameSite = normalizeCookieSameSite(input.sameSite)
	if (input.sameSite && !sameSite) {
		return writeCookieInputError(output, 'sameSite must be one of: Strict, Lax, None')
	}

	const expires = parseCookieExpires(input.expires, output)
	if (expires === null) {
		return null
	}

	if (input.session && input.expires) {
		return writeCookieInputError(output, 'Cannot combine --session with --expires')
	}

	if (sameSite === 'None' && input.secure !== true) {
		return writeCookieInputError(output, 'sameSite=None requires --secure')
	}

	const session = input.session === true || expires === undefined

	return {
		...identity,
		value: input.value,
		secure: input.secure === true,
		httpOnly: input.httpOnly === true,
		session,
		expires: session ? null : expires,
		sameSite,
	}
}

export const resolveCookieClearScope = (
	options: {
		forOrigin?: boolean
		site?: boolean
		domain?: string
		browserContext?: boolean
	},
	output: Output,
): CookieClearScope | null => {
	const scopes = [
		options.forOrigin ? 'origin' : null,
		options.site ? 'site' : null,
		options.domain?.trim() ? 'domain' : null,
		options.browserContext ? 'browserContext' : null,
	].filter(Boolean) as CookieClearScope[]

	if (scopes.length === 1) {
		return scopes[0]
	}

	return writeCookieInputError(output, 'Choose exactly one cookie clear scope: --for-origin, --site, --domain, or --browser-context')
}

export const filterCookies = (origin: string, cookies: AuthCookie[], options: CookieFilterOptions): AuthCookie[] => {
	const originHost = options.forOrigin ? getOriginHost(origin) : null
	return cookies.filter((cookie) => matchesCookieFilters(cookie, originHost, options))
}

export const formatCookieLine = (cookie: AuthCookie, showValues: boolean): string => {
	const flags = [formatExpiryFlag(cookie), cookie.httpOnly ? 'httpOnly' : null, cookie.secure ? 'secure' : null, formatSameSiteFlag(cookie)]
		.filter(Boolean)
		.join(',')
	const value = resolveCookieValue(cookie, showValues)
	const flagSuffix = flags ? ` [${flags}]` : ''
	const valueSuffix = value ? ` ${value}` : ''

	return `${cookie.name} ${cookie.domain}${cookie.path}${flagSuffix}${valueSuffix}`.trim()
}

export const formatCookieIdentityLine = (cookie: { name: string; domain: string; path: string }): string =>
	`${cookie.name} ${cookie.domain}${cookie.path}`

export const normalizeExportFormat = (format: string | undefined): 'netscape' | 'json' | 'header' | null => {
	if (!format) {
		return 'netscape'
	}
	if (!COOKIE_EXPORT_FORMATS.has(format)) {
		return null
	}

	switch (format) {
		case 'netscape':
		case 'json':
		case 'header':
			return format
		default:
			return null
	}
}

export const serializeCookies = (cookies: AuthCookie[], format: 'netscape' | 'json' | 'header'): string => {
	switch (format) {
		case 'netscape':
			return formatCookiesAsNetscape(cookies)
		case 'json':
			return JSON.stringify(cookies, null, 2)
		case 'header':
			return formatCookiesAsHeader(cookies)
	}
}

export const writeOutput = async (content: string, outPath?: string): Promise<void> => {
	const withTrailingNewline = content.endsWith('\n') ? content : `${content}\n`
	if (outPath && outPath !== '-') {
		await writeFile(outPath, withTrailingNewline, 'utf8')
		return
	}
	process.stdout.write(withTrailingNewline)
}

const writeCookieInputError = (output: Output, message: string): null => {
	output.writeWarn(message)
	process.exitCode = 2
	return null
}

const parseCookieExpires = (value: string | undefined, output: Output): number | null | undefined => {
	if (!value?.trim()) {
		return undefined
	}

	const trimmed = value.trim()
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed)
	}

	const timestamp = Date.parse(trimmed)
	if (!Number.isFinite(timestamp)) {
		return writeCookieInputError(output, `Invalid --expires value: ${value}. Use Unix seconds or an ISO timestamp.`)
	}

	return Math.floor(timestamp / 1000)
}

const buildCookieQuery = (input: CookieFetchInput): URLSearchParams => {
	const params = new URLSearchParams()
	if (input.domain?.trim()) {
		params.set('domain', input.domain.trim())
	}
	if (input.includeValues) {
		params.set('includeValues', 'true')
	}
	return params
}

const matchesCookieFilters = (cookie: AuthCookie, originHost: string | null, options: CookieFilterOptions): boolean => {
	if (options.sessionOnly && !cookie.session) {
		return false
	}
	if (options.httpOnly && !cookie.httpOnly) {
		return false
	}
	if (options.secure && !cookie.secure) {
		return false
	}
	if (originHost && !cookieMatchesHost(cookie.domain, originHost)) {
		return false
	}
	if (options.excludeTracking && isTrackingCookieName(cookie.name)) {
		return false
	}
	return true
}

const formatExpiryFlag = (cookie: AuthCookie): string | null => {
	if (cookie.session) {
		return 'session'
	}
	if (cookie.expires != null) {
		return `exp=${Math.trunc(cookie.expires)}`
	}
	return null
}

const formatSameSiteFlag = (cookie: AuthCookie): string | null => (cookie.sameSite ? `sameSite=${cookie.sameSite}` : null)

const resolveCookieValue = (cookie: AuthCookie, showValues: boolean): string => {
	if (showValues && cookie.value != null) {
		return cookie.value
	}

	return cookie.valuePreview ?? ''
}

const formatCookiesAsNetscape = (cookies: AuthCookie[]): string => {
	const lines = ['# Netscape HTTP Cookie File', '# This file was generated by Argus.', '']

	for (const cookie of cookies) {
		lines.push(
			[
				formatNetscapeDomain(cookie),
				cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
				cookie.path,
				cookie.secure ? 'TRUE' : 'FALSE',
				String(cookie.session ? 0 : Math.max(0, Math.trunc(cookie.expires ?? 0))),
				cookie.name,
				cookie.value ?? '',
			].join('\t'),
		)
	}

	return lines.join('\n')
}

const formatNetscapeDomain = (cookie: AuthCookie): string => (cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain)

const formatCookiesAsHeader = (cookies: AuthCookie[]): string =>
	`Cookie: ${cookies.map((cookie) => `${cookie.name}=${cookie.value ?? ''}`).join('; ')}`
