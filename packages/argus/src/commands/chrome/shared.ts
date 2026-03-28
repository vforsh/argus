import type { WatcherRecord } from '@vforsh/argus-core'
import type { ChromeTargetResponse } from '../../cdp/types.js'
import type { CdpEndpointOptions } from '../../cdp/resolveCdpEndpoint.js'
import { resolveCdpEndpoint } from '../../cdp/resolveCdpEndpoint.js'
import { fetchJson } from '../../httpClient.js'
import type { Output } from '../../output/io.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'

export type ChromeEndpointOptions = CdpEndpointOptions

export type ChromeVersionResponse = {
	Browser: string
	'Protocol-Version': string
	'User-Agent': string
	'V8-Version': string
	'WebKit-Version': string
	webSocketDebuggerUrl: string
}

export type ChromeCommandOptions = ChromeEndpointOptions & {
	json?: boolean
}

export const normalizeUrl = (url: string): string => {
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url
	}
	return `http://${url}`
}

export const resolveChromeEndpointOrExit = async (options: ChromeEndpointOptions, output: Output): Promise<{ host: string; port: number } | null> => {
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return null
	}

	return endpoint
}

export const loadChromeVersion = async (endpoint: { host: string; port: number }, output: Output): Promise<ChromeVersionResponse | null> => {
	try {
		return await fetchJson<ChromeVersionResponse>(`http://${endpoint.host}:${endpoint.port}/json/version`)
	} catch (error) {
		output.writeWarn(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return null
	}
}

export const loadChromeTargets = async (endpoint: { host: string; port: number }, output: Output): Promise<ChromeTargetResponse[] | null> => {
	try {
		return await fetchJson<ChromeTargetResponse[]>(`http://${endpoint.host}:${endpoint.port}/json/list`)
	} catch (error) {
		output.writeWarn(`Failed to load targets from ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return null
	}
}

export const resolveWatcherOrExit = async (id: string, output: Output): Promise<WatcherRecord | null> => {
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		process.exitCode = resolved.exitCode
		return null
	}

	return resolved.watcher
}
