import {
	getOriginHost,
	isTrackingCookieName,
	matchesCookieDomain,
	parseAuthStateSnapshot,
	type AuthCookie,
	type AuthCookiesResponse,
	type AuthStateLoadResponse,
	type AuthStateSnapshot,
	type WatcherRecord,
} from '@vforsh/argus-core'
import { readFile, writeFile } from 'node:fs/promises'
import { normalizeUrl } from './chrome/shared.js'
import type { Output } from '../output/io.js'
import { createOutput } from '../output/io.js'
import type { WatcherRequestSuccess } from '../watchers/requestWatcher.js'
import { requestWatcherAction, requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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

export type AuthExportStateOptions = {
	domain?: string
	out?: string
}

export type AuthLoadStateOptions = {
	inputPath: string
	url?: string
	json?: boolean
}

export type AuthCloneOptions = {
	targetId: string
	url?: string
	json?: boolean
}

type CookieFetchInput = {
	domain?: string
	includeValues?: boolean
}

type CookieFilterOptions = Pick<AuthCookiesOptions, 'sessionOnly' | 'httpOnly' | 'secure' | 'forOrigin' | 'excludeTracking'>
type AuthOutput = ReturnType<typeof createOutput>
type AuthWatcherPath = '/auth/cookies' | '/auth/state'
type AuthStateSnapshotResult = WatcherRequestSuccess<AuthStateSnapshot>
type AuthStateLoadResult = { watcher: WatcherRecord; data: AuthStateLoadResponse }

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

/** Execute `argus auth export-state`. */
export const runAuthExportState = async (id: string | undefined, options: AuthExportStateOptions): Promise<void> => {
	const output = createOutput({})
	const result = await requestAuthStateSnapshot(id, { domain: options.domain }, output)
	if (!result) {
		return
	}

	await writeOutput(JSON.stringify(result.data, null, 2), options.out)
}

/** Execute `argus auth load-state`. */
export const runAuthLoadState = async (id: string | undefined, options: AuthLoadStateOptions): Promise<void> => {
	const output = createOutput(options)
	const snapshot = await readAuthStateSnapshotOrExit(options.inputPath, output)
	if (!snapshot) {
		return
	}
	const result = await loadAuthStateIntoWatcher(id, snapshot, { url: options.url }, output)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	output.writeHuman(formatLoadStateMessage(result.watcher.id, result.data.startupUrl))
}

/** Execute `argus auth clone`. */
export const runAuthClone = async (sourceId: string | undefined, options: AuthCloneOptions): Promise<void> => {
	const output = createOutput(options)
	const source = await requestAuthStateSnapshot(sourceId, {}, output)
	if (!source) {
		return
	}

	const target = await loadAuthStateIntoWatcher(options.targetId, source.data, { url: options.url }, output)
	if (!target) {
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			from: source.watcher.id,
			to: target.watcher.id,
			startupUrl: target.data.startupUrl,
		})
		return
	}

	output.writeHuman(formatCloneStateMessage(source.watcher.id, target.watcher.id, target.data.startupUrl))
}

const fetchAuthCookies = async (id: string | undefined, input: CookieFetchInput, output: AuthOutput): Promise<AuthCookiesResponse | null> =>
	requestAuthData(id, '/auth/cookies', buildCookieQuery(input), output)

export const loadAuthStateSnapshot = async (inputPath: string): Promise<AuthStateSnapshot> => {
	const source = inputPath === '-' ? 'stdin' : `file ${inputPath}`
	const raw = await readAuthStateInput(inputPath)
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new Error(`Invalid auth state from ${source}: ${error instanceof Error ? error.message : String(error)}`)
	}

	return parseAuthStateSnapshot(parsed, `auth state ${source}`)
}

/**
 * Request an auth-state snapshot from a watcher and preserve watcher-resolution errors.
 * Shared by export, clone, and start --auth-from flows so they all use the same transport path.
 */
export const requestAuthStateSnapshot = async (
	id: string | undefined,
	input: { domain?: string },
	output: AuthOutput,
): Promise<AuthStateSnapshotResult | null> => {
	const result = await requestWatcherJson<AuthStateSnapshot>({
		id,
		path: '/auth/state',
		query: buildCookieQuery(input),
		timeoutMs: 10_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	return result
}

/** Load an auth-state snapshot into a target watcher. */
export const loadAuthStateIntoWatcher = async (
	id: string | undefined,
	snapshot: AuthStateSnapshot,
	input: { url?: string },
	output: AuthOutput,
): Promise<AuthStateLoadResult | null> => {
	const result = await requestWatcherAction<AuthStateLoadResponse>(
		{
			id,
			path: '/auth/state/load',
			method: 'POST',
			body: {
				snapshot,
				url: input.url ? normalizeUrl(input.url) : undefined,
			},
			timeoutMs: 15_000,
		},
		output,
	)

	if (!result) {
		return null
	}

	return result
}

const readAuthStateSnapshotOrExit = async (inputPath: string, output: Output): Promise<AuthStateSnapshot | null> => {
	try {
		return await loadAuthStateSnapshot(inputPath)
	} catch (error) {
		output.writeWarn(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
		return null
	}
}

const requestAuthData = async <T>(id: string | undefined, path: AuthWatcherPath, query: URLSearchParams, output: AuthOutput): Promise<T | null> => {
	const result = await requestWatcherJson<T>({
		id,
		path,
		query,
		timeoutMs: 10_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	return result.data
}

const readAuthStateInput = async (inputPath: string): Promise<string> => {
	if (inputPath !== '-') {
		return readFile(inputPath, 'utf8')
	}

	if (process.stdin.isTTY) {
		throw new Error('Cannot read auth state from stdin when stdin is a TTY. Pipe data or use --in <path>.')
	}

	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

const formatLoadStateMessage = (watcherId: string, startupUrl: string | null): string => {
	if (startupUrl) {
		return `loaded auth state into ${watcherId} and navigated to ${startupUrl}`
	}

	return `loaded auth state into ${watcherId}`
}

const formatCloneStateMessage = (sourceId: string, targetId: string, startupUrl: string | null): string => {
	if (startupUrl) {
		return `cloned auth state from ${sourceId} to ${targetId} and navigated to ${startupUrl}`
	}

	return `cloned auth state from ${sourceId} to ${targetId}`
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
	if (outPath && outPath !== '-') {
		await writeFile(outPath, withTrailingNewline, 'utf8')
		return
	}
	process.stdout.write(withTrailingNewline)
}
