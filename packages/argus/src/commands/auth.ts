import type { AuthCookie, AuthCookiesResponse } from '@vforsh/argus-core'
import { getOriginHost, isTrackingCookieName, matchesCookieDomain } from '@vforsh/argus-core'
import { writeFile } from 'node:fs/promises'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

export type AuthCookiesOptions = {
	json?: boolean
	domain?: string
	forOrigin?: boolean
	excludeTracking?: boolean
	showValues?: boolean
	sessionOnly?: boolean
	httpOnly?: boolean
	secure?: boolean
}

export type AuthExportCookiesOptions = {
	format?: string
	domain?: string
	forOrigin?: boolean
	excludeTracking?: boolean
	out?: string
}

type CookieFetchInput = {
	domain?: string
	includeValues?: boolean
}

type CookieFilterOptions = Pick<AuthCookiesOptions, 'sessionOnly' | 'httpOnly' | 'secure' | 'forOrigin' | 'excludeTracking'>

const COOKIE_EXPORT_FORMATS = new Set(['netscape', 'json', 'header'])

/** Execute `argus auth cookies`. */
export const runAuthCookies = async (id: string | undefined, options: AuthCookiesOptions): Promise<void> => {
	const output = createOutput(options)
	const includeValues = options.showValues === true
	const response = await fetchAuthCookies(id, { domain: options.domain, includeValues }, output)
	if (!response) {
		return
	}

	const cookies = filterCookies(response.origin, response.cookies, options)

	if (options.json) {
		output.writeJson({ ...response, cookies })
		return
	}

	if (cookies.length === 0) {
		output.writeHuman('No cookies matched.')
		return
	}

	for (const cookie of cookies) {
		output.writeHuman(formatCookieLine(cookie, includeValues))
	}
}

/** Execute `argus auth export-cookies`. */
export const runAuthExportCookies = async (id: string | undefined, options: AuthExportCookiesOptions): Promise<void> => {
	const output = createOutput({})
	const format = normalizeExportFormat(options.format)

	if (!format) {
		output.writeWarn(`Invalid --format value: ${options.format}. Expected one of: netscape, json, header.`)
		process.exitCode = 2
		return
	}

	const response = await fetchAuthCookies(id, { domain: options.domain, includeValues: true }, output)
	if (!response) {
		return
	}

	const serialized = serializeCookies(filterCookies(response.origin, response.cookies, options), format)
	await writeOutput(serialized, options.out)
}

const fetchAuthCookies = async (
	id: string | undefined,
	input: CookieFetchInput,
	output: ReturnType<typeof createOutput>,
): Promise<AuthCookiesResponse | null> => {
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

const filterCookies = (origin: string, cookies: AuthCookie[], options: CookieFilterOptions): AuthCookie[] => {
	const originHost = options.forOrigin ? getOriginHost(origin) : null

	return cookies.filter((cookie) => matchesCookieFilters(cookie, originHost, options))
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
	if (originHost && !matchesCookieDomain(cookie.domain, originHost)) {
		return false
	}
	if (options.excludeTracking && isTrackingCookieName(cookie.name)) {
		return false
	}
	return true
}

const formatCookieLine = (cookie: AuthCookie, showValues: boolean): string => {
	const flags = [formatExpiryFlag(cookie), cookie.httpOnly ? 'httpOnly' : null, cookie.secure ? 'secure' : null, formatSameSiteFlag(cookie)]
		.filter(Boolean)
		.join(',')
	const value = resolveCookieValue(cookie, showValues)
	const flagSuffix = flags ? ` [${flags}]` : ''
	const valueSuffix = value ? ` ${value}` : ''

	return `${cookie.name} ${cookie.domain}${cookie.path}${flagSuffix}${valueSuffix}`.trim()
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

const formatSameSiteFlag = (cookie: AuthCookie): string | null => {
	if (!cookie.sameSite) {
		return null
	}

	return `sameSite=${cookie.sameSite}`
}

const resolveCookieValue = (cookie: AuthCookie, showValues: boolean): string => {
	if (showValues && cookie.value != null) {
		return cookie.value
	}

	return cookie.valuePreview ?? ''
}

const normalizeExportFormat = (format: string | undefined): 'netscape' | 'json' | 'header' | null => {
	if (!format) return 'netscape'
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

const serializeCookies = (cookies: AuthCookie[], format: 'netscape' | 'json' | 'header'): string => {
	switch (format) {
		case 'netscape':
			return formatCookiesAsNetscape(cookies)
		case 'json':
			return JSON.stringify(cookies, null, 2)
		case 'header':
			return formatCookiesAsHeader(cookies)
	}
}

const writeOutput = async (content: string, outPath?: string): Promise<void> => {
	const withTrailingNewline = content.endsWith('\n') ? content : `${content}\n`
	if (outPath) {
		await writeFile(outPath, withTrailingNewline, 'utf8')
		return
	}
	process.stdout.write(withTrailingNewline)
}
