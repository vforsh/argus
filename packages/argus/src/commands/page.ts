import type { StatusResponse } from '@vforsh/argus-core'
import type { ChromeTargetResponse } from '../cdp/types.js'
import type { CdpEndpointOptions } from '../cdp/resolveCdpEndpoint.js'
import { resolveCdpEndpoint } from '../cdp/resolveCdpEndpoint.js'
import { selectTargetFromCandidates } from '../cdp/selectTarget.js'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

export type PageEndpointOptions = CdpEndpointOptions

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

export type PageReloadOptions = PageCommandOptions & {
	targetId?: string
	param?: string[]
	params?: string
}

export const runPageReload = async (options: PageReloadOptions): Promise<void> => {
	const output = createOutput(options)
	const hasParamFlag = (options.param?.length ?? 0) > 0
	const hasParamsFlag = options.params != null

	if (!options.targetId && options.id) {
		if (options.cdp) {
			output.writeWarn('--cdp cannot be used without a targetId. Use --id to resolve the endpoint.')
			process.exitCode = 2
			return
		}

		const resolvedWatcher = await resolveWatcher({ id: options.id })
		if (!resolvedWatcher.ok) {
			output.writeWarn(resolvedWatcher.error)
			if (resolvedWatcher.candidates && resolvedWatcher.candidates.length > 0) {
				writeWatcherCandidates(resolvedWatcher.candidates, output)
				output.writeWarn('Hint: run `argus list` to see all watchers.')
			}
			process.exitCode = resolvedWatcher.exitCode
			return
		}

		const statusUrl = `http://${resolvedWatcher.watcher.host}:${resolvedWatcher.watcher.port}/status`
		let status: StatusResponse
		try {
			status = await fetchJson<StatusResponse>(statusUrl, { timeoutMs: 2_000 })
		} catch (error) {
			output.writeWarn(`${resolvedWatcher.watcher.id}: failed to reach watcher (${error instanceof Error ? error.message : error})`)
			process.exitCode = 1
			return
		}

		if (!status.attached || !status.target) {
			output.writeWarn(`Watcher ${resolvedWatcher.watcher.id} is not attached to a target.`)
			process.exitCode = 1
			return
		}

		const endpoint = await resolveCdpEndpoint({ id: resolvedWatcher.watcher.id })
		if (!endpoint.ok) {
			output.writeWarn(endpoint.error)
			process.exitCode = endpoint.exitCode
			return
		}

		const targetsUrl = `http://${endpoint.host}:${endpoint.port}/json/list`
		let targets: ChromeTargetResponse[]
		try {
			targets = await fetchJson<ChromeTargetResponse[]>(targetsUrl)
		} catch (error) {
			output.writeWarn(`Failed to load targets from ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}

		const candidates = findTargetsByAttached(status.target, targets)
		const selection = await selectTargetFromCandidates(candidates, output, {
			interactive: process.stdin.isTTY === true,
			messages: {
				empty: 'No targets matched the attached page.',
				ambiguous: 'Multiple targets matched the attached page.',
			},
		})
		if (!selection.ok) {
			output.writeWarn(selection.error)
			process.exitCode = selection.exitCode
			return
		}

		await reloadTarget(selection.target, { hasParamFlag, hasParamsFlag, options, output })
		return
	}

	if (!options.targetId || options.targetId.trim() === '') {
		output.writeWarn('Provide a targetId or use --id <watcherId> to reload the attached page.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const targetId = options.targetId.trim()
	const targetsUrl = `http://${endpoint.host}:${endpoint.port}/json/list`

	let targets: ChromeTargetResponse[]
	try {
		targets = await fetchJson<ChromeTargetResponse[]>(targetsUrl)
	} catch (error) {
		output.writeWarn(`Failed to load targets from ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	const target = targets.find((entry) => entry.id === targetId)
	if (!target) {
		output.writeWarn(`Target not found: ${targetId}`)
		process.exitCode = 2
		return
	}

	await reloadTarget(target, { hasParamFlag, hasParamsFlag, options, output })
}

type ReloadContext = {
	hasParamFlag: boolean
	hasParamsFlag: boolean
	options: PageReloadOptions
	output: ReturnType<typeof createOutput>
}

const reloadTarget = async (target: ChromeTargetResponse, context: ReloadContext): Promise<void> => {
	const { options, output } = context

	if (!target.webSocketDebuggerUrl) {
		output.writeWarn(`Target ${target.id} has no webSocketDebuggerUrl.`)
		process.exitCode = 1
		return
	}

	if (!context.hasParamFlag && !context.hasParamsFlag) {
		try {
			await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.reload' })
		} catch (error) {
			output.writeWarn(`Failed to reload target ${target.id}: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}

		if (options.json) {
			output.writeJson({ reloaded: target.id, url: target.url })
		} else {
			output.writeHuman(`reloaded ${target.id}`)
		}
		return
	}

	if (!target.url || target.url.trim() === '') {
		output.writeWarn(`Target ${target.id} has no URL.`)
		process.exitCode = 2
		return
	}

	if (!isHttpUrl(target.url)) {
		output.writeWarn(`Target URL "${target.url}" is not http/https. Cannot update query params.`)
		process.exitCode = 2
		return
	}

	let parsedUrl: URL
	try {
		parsedUrl = new URL(target.url)
	} catch (error) {
		output.writeWarn(`Invalid target URL "${target.url}": ${error instanceof Error ? error.message : error}`)
		process.exitCode = 2
		return
	}

	const previousUrl = target.url

	if (context.hasParamsFlag) {
		const parsed = parseParamsString(options.params!)
		if ('error' in parsed) {
			output.writeWarn(parsed.error)
			process.exitCode = 2
			return
		}
		for (const [key, value] of parsed.entries()) {
			parsedUrl.searchParams.set(key, value)
		}
	}

	if (context.hasParamFlag) {
		for (const paramPair of options.param!) {
			const parsed = parseParamPair(paramPair)
			if ('error' in parsed) {
				output.writeWarn(parsed.error)
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
		output.writeWarn(`Failed to navigate target ${target.id}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ reloaded: target.id, url: nextUrl, previousUrl })
	} else {
		output.writeHuman(`reloaded ${target.id} ${nextUrl}`)
	}
}

const findTargetsByAttached = (attached: { title: string | null; url: string | null }, targets: ChromeTargetResponse[]): ChromeTargetResponse[] => {
	if (attached.url) {
		const urlMatches = targets.filter((target) => target.url === attached.url)
		if (urlMatches.length > 0) {
			return urlMatches
		}
	}

	if (attached.title) {
		return targets.filter((target) => target.title === attached.title)
	}

	return []
}
