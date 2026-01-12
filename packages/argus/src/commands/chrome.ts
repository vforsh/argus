import type { RegistryV1, WatcherChrome } from '@vforsh/argus-core'
import { fetchJson, fetchText } from '../httpClient.js'
import { loadRegistry, pruneRegistry } from '../registry.js'

export type ChromeEndpointOptions = {
	host?: string
	port?: string | number
	id?: string
}

export type ChromeVersionResponse = {
	Browser: string
	'Protocol-Version': string
	'User-Agent': string
	'V8-Version': string
	'WebKit-Version': string
	webSocketDebuggerUrl: string
}

export type ChromeTargetResponse = {
	id: string
	type: string
	title: string
	url: string
	webSocketDebuggerUrl?: string
	devtoolsFrontendUrl?: string
	description?: string
	faviconUrl?: string
}

type CdpEndpointResult =
	| { ok: true; host: string; port: number }
	| { ok: false; error: string; exitCode: 1 | 2 }

const isValidPort = (port: number): boolean => Number.isFinite(port) && port >= 1 && port <= 65535

const parsePort = (value: string | number): number | null => {
	const port = typeof value === 'string' ? parseInt(value, 10) : value
	return isValidPort(port) ? port : null
}

const resolveCdpEndpoint = async (options: ChromeEndpointOptions): Promise<CdpEndpointResult> => {
	if (options.host != null || options.port != null) {
		if (options.host == null || options.port == null) {
			return { ok: false, error: 'Both --host and --port must be specified together.', exitCode: 2 }
		}
		const port = parsePort(options.port)
		if (port === null) {
			return { ok: false, error: `Invalid port: ${options.port}. Must be an integer 1-65535.`, exitCode: 2 }
		}
		return { ok: true, host: options.host, port }
	}

	if (options.id != null) {
		let registry: RegistryV1
		try {
			registry = await pruneRegistry(await loadRegistry())
		} catch (error) {
			return { ok: false, error: `Failed to load registry: ${error instanceof Error ? error.message : error}`, exitCode: 1 }
		}

		const watcher = registry.watchers[options.id]
		if (!watcher) {
			return { ok: false, error: `Watcher not found: ${options.id}`, exitCode: 2 }
		}
		if (!watcher.chrome) {
			return { ok: false, error: `Watcher "${options.id}" has no chrome connection configured.`, exitCode: 2 }
		}
		return { ok: true, host: watcher.chrome.host, port: watcher.chrome.port }
	}

	return { ok: true, host: '127.0.0.1', port: 9222 }
}

const normalizeUrl = (url: string): string => {
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url
	}
	return `http://${url}`
}

export type ChromeCommandOptions = ChromeEndpointOptions & {
	json?: boolean
}

export const runChromeVersion = async (options: ChromeCommandOptions): Promise<void> => {
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/version`

	let response: ChromeVersionResponse
	try {
		response = await fetchJson<ChromeVersionResponse>(url)
	} catch (error) {
		console.error(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
	} else {
		console.log(`Browser: ${response.Browser}`)
		console.log(`WebSocket: ${response.webSocketDebuggerUrl}`)
	}
}

export const runChromeStatus = async (options: ChromeCommandOptions): Promise<void> => {
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/version`

	let response: ChromeVersionResponse
	try {
		response = await fetchJson<ChromeVersionResponse>(url)
	} catch (error) {
		console.error(`unreachable ${endpoint.host}:${endpoint.port}`)
		process.exitCode = 1
		return
	}

	if (!response.Browser) {
		console.error(`invalid response from ${endpoint.host}:${endpoint.port}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
	} else {
		console.log(`ok ${endpoint.host}:${endpoint.port} ${response.Browser}`)
	}
}

export type ChromeTargetsOptions = ChromeCommandOptions & {
	type?: string
}

export const runChromeTargets = async (options: ChromeTargetsOptions): Promise<void> => {
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/list`

	let targets: ChromeTargetResponse[]
	try {
		targets = await fetchJson<ChromeTargetResponse[]>(url)
	} catch (error) {
		console.error(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.type) {
		targets = targets.filter((t) => t.type === options.type)
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(targets) + '\n')
	} else {
		for (const target of targets) {
			const title = target.title ? ` ${target.title}` : ''
			const targetUrl = target.url ? ` ${target.url}` : ''
			console.log(`${target.id} ${target.type}${title}${targetUrl}`)
		}
	}
}

export type ChromeOpenOptions = ChromeCommandOptions & {
	url: string
}

export const runChromeOpen = async (options: ChromeOpenOptions): Promise<void> => {
	if (!options.url || options.url.trim() === '') {
		console.error('--url is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const normalizedUrl = normalizeUrl(options.url.trim())
	const encodedUrl = encodeURIComponent(normalizedUrl)
	const url = `http://${endpoint.host}:${endpoint.port}/json/new?${encodedUrl}`

	let target: ChromeTargetResponse
	try {
		target = await fetchJson<ChromeTargetResponse>(url, { method: 'PUT' })
	} catch (error) {
		console.error(`Failed to open tab: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(target) + '\n')
	} else {
		console.log(`${target.id} ${target.url}`)
	}
}

export type ChromeActivateOptions = ChromeCommandOptions & {
	targetId: string
}

export const runChromeActivate = async (options: ChromeActivateOptions): Promise<void> => {
	if (!options.targetId || options.targetId.trim() === '') {
		console.error('targetId is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const targetId = options.targetId.trim()
	const url = `http://${endpoint.host}:${endpoint.port}/json/activate/${targetId}`

	try {
		await fetchText(url)
	} catch (error) {
		console.error(`Failed to activate target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify({ activated: targetId }) + '\n')
	} else {
		console.log(`activated ${targetId}`)
	}
}

export type ChromeCloseOptions = ChromeCommandOptions & {
	targetId: string
}

export const runChromeClose = async (options: ChromeCloseOptions): Promise<void> => {
	if (!options.targetId || options.targetId.trim() === '') {
		console.error('targetId is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		console.error(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const targetId = options.targetId.trim()
	const url = `http://${endpoint.host}:${endpoint.port}/json/close/${targetId}`

	try {
		await fetchText(url)
	} catch (error) {
		console.error(`Failed to close target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify({ closed: targetId }) + '\n')
	} else {
		console.log(`closed ${targetId}`)
	}
}
