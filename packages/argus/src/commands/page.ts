import type { RegistryV1 } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { loadRegistry, pruneRegistry } from '../registry.js'

export type PageEndpointOptions = {
	host?: string
	port?: string | number
	id?: string
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

type CdpEndpointResult = { ok: true; host: string; port: number } | { ok: false; error: string; exitCode: 1 | 2 }

const isValidPort = (port: number): boolean => Number.isFinite(port) && port >= 1 && port <= 65535

const parsePort = (value: string | number): number | null => {
	const port = typeof value === 'string' ? parseInt(value, 10) : value
	return isValidPort(port) ? port : null
}

const resolveCdpEndpoint = async (options: PageEndpointOptions): Promise<CdpEndpointResult> => {
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

type WebSocketLike = {
	addEventListener: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	removeEventListener?: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	send: (data: string) => void
	close: () => void
	readyState?: number
}

type WebSocketCtor = new (url: string) => WebSocketLike

const getWebSocketCtor = (): WebSocketCtor | null => {
	const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
	return ctor ?? null
}

const toMessageText = (data: unknown): string | null => {
	if (typeof data === 'string') {
		return data
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8')
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8')
	}
	return null
}

const sendCdpCommand = async (
	wsUrl: string,
	payload: { id: number; method: string; params?: Record<string, unknown> },
	timeoutMs = 5_000,
): Promise<void> => {
	const WebSocketConstructor = getWebSocketCtor()
	if (!WebSocketConstructor) {
		throw new Error('WebSocket unavailable. Node 18+ required.')
	}

	const ws = new WebSocketConstructor(wsUrl)
	const requestId = payload.id

	await new Promise<void>((resolve, reject) => {
		let settled = false
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true
				try {
					ws.close()
				} catch {}
				reject(new Error(`CDP command timed out after ${timeoutMs}ms`))
			}
		}, timeoutMs)

		const cleanup = () => {
			clearTimeout(timer)
			ws.removeEventListener?.('open', onOpen)
			ws.removeEventListener?.('message', onMessage)
			ws.removeEventListener?.('error', onError)
			ws.removeEventListener?.('close', onClose)
		}

		const finish = (error?: Error) => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			try {
				ws.close()
			} catch {}
			if (error) {
				reject(error)
			} else {
				resolve()
			}
		}

		const onOpen = () => {
			try {
				ws.send(JSON.stringify(payload))
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onMessage = (event: { data?: unknown }) => {
			const text = toMessageText(event.data)
			if (!text) {
				return
			}
			try {
				const message = JSON.parse(text) as { id?: number; error?: { message?: string } }
				if (message.id !== requestId) {
					return
				}
				if (message.error?.message) {
					finish(new Error(message.error.message))
					return
				}
				finish()
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onError = () => {
			finish(new Error('WebSocket error'))
		}

		const onClose = () => {
			finish(new Error('WebSocket closed before response'))
		}

		ws.addEventListener('open', onOpen)
		ws.addEventListener('message', onMessage)
		ws.addEventListener('error', onError)
		ws.addEventListener('close', onClose)
	})
}

export type PageCommandOptions = PageEndpointOptions & {
	json?: boolean
}

const parseParamPair = (value: string): { key: string; value: string } | { error: string } => {
	const eqIdx = value.indexOf('=')
	if (eqIdx === -1) {
		return { error: `Invalid --param "${value}": missing "=".` }
	}
	const key = value.slice(0, eqIdx)
	if (key === '') {
		return { error: `Invalid --param "${value}": empty key.` }
	}
	return { key, value: value.slice(eqIdx + 1) }
}

const parseParamsString = (value: string): URLSearchParams | { error: string } => {
	const params = new URLSearchParams()
	if (value.trim() === '') {
		return params
	}

	const pairs = value.split('&')
	for (const pair of pairs) {
		const eqIdx = pair.indexOf('=')
		if (eqIdx === -1) {
			return { error: `Invalid --params "${pair}": missing "=".` }
		}
		const key = pair.slice(0, eqIdx)
		if (key === '') {
			return { error: `Invalid --params "${pair}": empty key.` }
		}
		params.set(decodeURIComponent(key), decodeURIComponent(pair.slice(eqIdx + 1)))
	}
	return params
}

const isHttpUrl = (url: string): boolean => {
	return url.startsWith('http://') || url.startsWith('https://')
}

export type PageReloadOptions = PageCommandOptions & {
	targetId: string
	param?: string[]
	params?: string
}

export const runPageReload = async (options: PageReloadOptions): Promise<void> => {
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
	const targetsUrl = `http://${endpoint.host}:${endpoint.port}/json/list`

	let targets: ChromeTargetResponse[]
	try {
		targets = await fetchJson<ChromeTargetResponse[]>(targetsUrl)
	} catch (error) {
		console.error(`Failed to load targets from ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	const target = targets.find((entry) => entry.id === targetId)
	if (!target) {
		console.error(`Target not found: ${targetId}`)
		process.exitCode = 2
		return
	}

	if (!target.webSocketDebuggerUrl) {
		console.error(`Target ${targetId} has no webSocketDebuggerUrl.`)
		process.exitCode = 1
		return
	}

	const hasParamFlag = options.param && options.param.length > 0
	const hasParamsFlag = options.params != null

	if (!hasParamFlag && !hasParamsFlag) {
		try {
			await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.reload' })
		} catch (error) {
			console.error(`Failed to reload target ${targetId}: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}

		if (options.json) {
			process.stdout.write(JSON.stringify({ reloaded: targetId, url: target.url }) + '\n')
		} else {
			console.log(`reloaded ${targetId}`)
		}
		return
	}

	if (!target.url || target.url.trim() === '') {
		console.error(`Target ${targetId} has no URL.`)
		process.exitCode = 2
		return
	}

	if (!isHttpUrl(target.url)) {
		console.error(`Target URL "${target.url}" is not http/https. Cannot update query params.`)
		process.exitCode = 2
		return
	}

	let parsedUrl: URL
	try {
		parsedUrl = new URL(target.url)
	} catch (error) {
		console.error(`Invalid target URL "${target.url}": ${error instanceof Error ? error.message : error}`)
		process.exitCode = 2
		return
	}

	const previousUrl = target.url

	if (hasParamsFlag) {
		const parsed = parseParamsString(options.params!)
		if ('error' in parsed) {
			console.error(parsed.error)
			process.exitCode = 2
			return
		}
		for (const [key, value] of parsed.entries()) {
			parsedUrl.searchParams.set(key, value)
		}
	}

	if (hasParamFlag) {
		for (const paramPair of options.param!) {
			const parsed = parseParamPair(paramPair)
			if ('error' in parsed) {
				console.error(parsed.error)
				process.exitCode = 2
				return
			}
			parsedUrl.searchParams.set(parsed.key, parsed.value)
		}
	}

	const nextUrl = parsedUrl.toString()

	try {
		await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.navigate', params: { url: nextUrl } })
	} catch (error) {
		console.error(`Failed to navigate target ${targetId}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify({ reloaded: targetId, url: nextUrl, previousUrl }) + '\n')
	} else {
		console.log(`reloaded ${targetId} ${nextUrl}`)
	}
}
