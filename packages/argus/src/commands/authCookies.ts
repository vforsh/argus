import type { AuthCookieClearResponse, AuthCookieDeleteResponse, AuthCookieGetResponse, AuthCookieSetResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { createOutput } from '../output/io.js'
import {
	fetchAuthCookies,
	filterCookies,
	formatCookieIdentityLine,
	formatCookieLine,
	normalizeCookieIdentityInput,
	normalizeExportFormat,
	parseCookieSetInput,
	resolveCookieClearScope,
	serializeCookies,
	writeOutput,
} from './authCookieSupport.js'

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

export type AuthCookieGetOptions = {
	domain: string
	path: string
	showValue?: boolean
	json?: boolean
}

export type AuthCookieSetOptions = {
	domain: string
	path: string
	secure?: boolean
	httpOnly?: boolean
	sameSite?: string
	expires?: string
	session?: boolean
	json?: boolean
}

export type AuthCookieDeleteOptions = {
	domain: string
	path: string
	json?: boolean
}

export type AuthCookieClearOptions = {
	forOrigin?: boolean
	site?: boolean
	domain?: string
	browserContext?: boolean
	sessionOnly?: boolean
	authOnly?: boolean
	json?: boolean
}

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

/** Execute `argus auth cookies get`. */
export const runAuthCookieGet = defineWatcherCommand<AuthCookieGetOptions, AuthCookieGetResponse, unknown, [name: string]>({
	build: ([name], options, output) => {
		const identity = normalizeCookieIdentityInput({ name, domain: options.domain, path: options.path }, output)
		if (!identity) {
			return null
		}

		return {
			path: '/auth/cookies/get',
			method: 'POST',
			body: {
				...identity,
				includeValue: options.showValue === true,
			},
		}
	},
	formatHuman: (response, { output, options }) => {
		if (!response.cookie) {
			output.writeHuman('No cookie matched exact identity.')
			return
		}

		output.writeHuman(formatCookieLine(response.cookie, options.showValue === true))
	},
})

/** Execute `argus auth cookies set`. */
export const runAuthCookieSet = defineWatcherCommand<AuthCookieSetOptions, AuthCookieSetResponse, unknown, [name: string, value: string]>({
	build: ([name, value], options, output) => {
		const cookie = parseCookieSetInput({ name, value, ...options }, output)
		if (!cookie) {
			return null
		}

		return {
			path: '/auth/cookies/set',
			method: 'POST',
			body: { cookie },
		}
	},
	formatHuman: (response, { output }) => {
		output.writeHuman(`Set ${formatCookieLine(response.cookie, false)}`)
	},
})

/** Execute `argus auth cookies delete`. */
export const runAuthCookieDelete = defineWatcherCommand<AuthCookieDeleteOptions, AuthCookieDeleteResponse, unknown, [name: string]>({
	build: ([name], options, output) => {
		const identity = normalizeCookieIdentityInput({ name, domain: options.domain, path: options.path }, output)
		if (!identity) {
			return null
		}

		return {
			path: '/auth/cookies/delete',
			method: 'POST',
			body: identity,
		}
	},
	formatHuman: (response, { output }) => {
		if (!response.deleted) {
			output.writeHuman('No cookie matched exact identity.')
			return
		}

		output.writeHuman(`Deleted ${formatCookieIdentityLine(response.cookie)}`)
	},
})

/** Execute `argus auth cookies clear`. */
export const runAuthCookieClear = defineWatcherCommand<AuthCookieClearOptions, AuthCookieClearResponse>({
	build: (_args, options, output) => {
		const scope = resolveCookieClearScope(options, output)
		if (!scope) {
			return null
		}

		return {
			path: '/auth/cookies/clear',
			method: 'POST',
			body: {
				scope,
				domain: scope === 'domain' ? options.domain : undefined,
				sessionOnly: options.sessionOnly === true,
				authOnly: options.authOnly === true,
			},
		}
	},
	formatHuman: (response, { output }) => {
		const scopeSuffix = response.scopeValue ? ` (${response.scopeValue})` : ''
		output.writeHuman(`Cleared ${response.cleared} cookie(s) from ${response.scope}${scopeSuffix}`)
		for (const cookie of response.cookies) {
			output.writeHuman(formatCookieIdentityLine(cookie))
		}
	},
})
