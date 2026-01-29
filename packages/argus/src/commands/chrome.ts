import { execFile } from 'node:child_process'
import type { ChromeTargetResponse } from '../cdp/types.js'
import type { CdpEndpointOptions } from '../cdp/resolveCdpEndpoint.js'
import { resolveCdpEndpoint } from '../cdp/resolveCdpEndpoint.js'
import { filterTargets, selectTargetFromCandidates } from '../cdp/selectTarget.js'
import { fetchJson, fetchText } from '../httpClient.js'
import { createOutput } from '../output/io.js'

export type ChromeEndpointOptions = CdpEndpointOptions

export type ChromeVersionResponse = {
	Browser: string
	'Protocol-Version': string
	'User-Agent': string
	'V8-Version': string
	'WebKit-Version': string
	webSocketDebuggerUrl: string
}

const normalizeUrl = (url: string): string => {
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url
	}
	return `http://${url}`
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

export type ChromeCommandOptions = ChromeEndpointOptions & {
	json?: boolean
}

export const runChromeVersion = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/version`

	let response: ChromeVersionResponse
	try {
		response = await fetchJson<ChromeVersionResponse>(url)
	} catch (error) {
		output.writeWarn(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
	} else {
		output.writeHuman(`Browser: ${response.Browser}`)
		output.writeHuman(`WebSocket: ${response.webSocketDebuggerUrl}`)
	}
}

export const runChromeStatus = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/version`

	let response: ChromeVersionResponse
	try {
		response = await fetchJson<ChromeVersionResponse>(url)
	} catch (error) {
		output.writeWarn(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (!response.Browser) {
		output.writeWarn(`invalid response from ${endpoint.host}:${endpoint.port}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
	} else {
		output.writeHuman(`ok ${endpoint.host}:${endpoint.port} ${response.Browser}`)
	}
}

export type ChromeTargetsOptions = ChromeCommandOptions & {
	type?: string
	tree?: boolean
}

export const runChromeTargets = async (options: ChromeTargetsOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/list`

	let targets: ChromeTargetResponse[]
	try {
		targets = await fetchJson<ChromeTargetResponse[]>(url)
	} catch (error) {
		output.writeWarn(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.type) {
		targets = targets.filter((t) => t.type === options.type)
	}

	if (options.json) {
		output.writeJson(targets)
	} else if (options.tree) {
		renderTargetTree(targets, output)
	} else {
		for (const target of targets) {
			const title = target.title ? ` ${target.title}` : ''
			const targetUrl = target.url ? ` ${target.url}` : ''
			const parentInfo = target.parentId ? ` [parent: ${target.parentId.slice(0, 8)}...]` : ''
			output.writeHuman(`${target.id} ${target.type}${title}${targetUrl}${parentInfo}`)
		}
	}
}

/**
 * Render targets as a tree showing parent-child relationships.
 */
const renderTargetTree = (targets: ChromeTargetResponse[], output: { writeHuman: (msg: string) => void }): void => {
	// Build lookup maps
	const targetById = new Map(targets.map((t) => [t.id, t]))
	const childrenByParent = new Map<string | null, ChromeTargetResponse[]>()

	for (const target of targets) {
		const parentId = target.parentId ?? null
		const children = childrenByParent.get(parentId) ?? []
		children.push(target)
		childrenByParent.set(parentId, children)
	}

	// Find root targets (no parent or parent not in our list)
	const roots = targets.filter((t) => !t.parentId || !targetById.has(t.parentId))

	const renderNode = (target: ChromeTargetResponse, prefix: string, isLast: boolean): void => {
		const connector = isLast ? '└── ' : '├── '
		const title = target.title || '(untitled)'
		const shortId = target.id.slice(0, 8) + '...'
		output.writeHuman(`${prefix}${connector}${title} (${target.type}, ${shortId})`)
		output.writeHuman(`${prefix}${isLast ? '    ' : '│   '}${target.url}`)

		const children = childrenByParent.get(target.id) ?? []
		children.forEach((child, index) => {
			const childIsLast = index === children.length - 1
			renderNode(child, prefix + (isLast ? '    ' : '│   '), childIsLast)
		})
	}

	if (roots.length === 0) {
		output.writeHuman('(no targets)')
		return
	}

	roots.forEach((root, index) => {
		const isLast = index === roots.length - 1
		const title = root.title || '(untitled)'
		const shortId = root.id.slice(0, 8) + '...'
		output.writeHuman(`${title} (${root.type}, ${shortId})`)
		output.writeHuman(`${root.url}`)

		const children = childrenByParent.get(root.id) ?? []
		children.forEach((child, childIndex) => {
			const childIsLast = childIndex === children.length - 1
			renderNode(child, '', childIsLast)
		})

		if (!isLast) {
			output.writeHuman('')
		}
	})
}

export type ChromeOpenOptions = ChromeCommandOptions & {
	url: string
}

export const runChromeOpen = async (options: ChromeOpenOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.url || options.url.trim() === '') {
		output.writeWarn('--url is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
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
		output.writeWarn(`Failed to open tab: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(target)
	} else {
		output.writeHuman(`${target.id} ${target.url}`)
	}
}

export type ChromeActivateOptions = ChromeCommandOptions & {
	targetId?: string
	title?: string
	url?: string
	match?: string
}

export const runChromeActivate = async (options: ChromeActivateOptions): Promise<void> => {
	const output = createOutput(options)
	const targetIdInput = options.targetId?.trim()
	const hasTargetId = Boolean(targetIdInput)
	const hasFilters = Boolean(options.title || options.url || options.match)
	if (hasTargetId && hasFilters) {
		output.writeWarn('Cannot combine targetId with --title/--url/--match.')
		process.exitCode = 2
		return
	}

	if (!hasTargetId && !hasFilters) {
		output.writeWarn('targetId or --title/--url/--match is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	let targetId = targetIdInput

	if (!targetId) {
		const url = `http://${endpoint.host}:${endpoint.port}/json/list`
		let targets: ChromeTargetResponse[]
		try {
			targets = await fetchJson<ChromeTargetResponse[]>(url)
		} catch (error) {
			output.writeWarn(`Failed to load targets from ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}

		const candidates = filterTargets(targets, { title: options.title, url: options.url, match: options.match })
		const selection = await selectTargetFromCandidates(candidates, output, {
			interactive: process.stdin.isTTY === true,
			messages: {
				empty: 'No targets matched the provided filters.',
				ambiguous: 'Multiple targets matched. Provide a narrower filter or a targetId.',
			},
		})
		if (!selection.ok) {
			output.writeWarn(selection.error)
			process.exitCode = selection.exitCode
			return
		}
		targetId = selection.target.id
	}

	const activateUrl = `http://${endpoint.host}:${endpoint.port}/json/activate/${targetId}`
	try {
		await fetchText(activateUrl)
	} catch (error) {
		output.writeWarn(`Failed to activate target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ activated: targetId })
	} else {
		output.writeHuman(`activated ${targetId}`)
	}
}

export type ChromeCloseOptions = ChromeCommandOptions & {
	targetId: string
}

export const runChromeClose = async (options: ChromeCloseOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.targetId || options.targetId.trim() === '') {
		output.writeWarn('targetId is required.')
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
	const url = `http://${endpoint.host}:${endpoint.port}/json/close/${targetId}`

	try {
		await fetchText(url)
	} catch (error) {
		output.writeWarn(`Failed to close target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ closed: targetId })
	} else {
		output.writeHuman(`closed ${targetId}`)
	}
}

export const runChromeStop = async (options: ChromeCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return
	}

	const url = `http://${endpoint.host}:${endpoint.port}/json/version`

	let response: ChromeVersionResponse
	try {
		response = await fetchJson<ChromeVersionResponse>(url)
	} catch (error) {
		output.writeWarn(`Failed to connect to Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (!response.webSocketDebuggerUrl) {
		output.writeWarn(`No browser WebSocket endpoint exposed at ${endpoint.host}:${endpoint.port}.`)
		process.exitCode = 1
		return
	}

	try {
		await sendCdpCommand(response.webSocketDebuggerUrl, { id: 1, method: 'Browser.close' })
	} catch (error) {
		output.writeWarn(`Failed to close Chrome at ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ closed: true, host: endpoint.host, port: endpoint.port })
	} else {
		output.writeHuman(`closed ${endpoint.host}:${endpoint.port}`)
	}
}

export type ChromeReloadOptions = ChromeCommandOptions & {
	targetId: string
}

export const runChromeReload = async (options: ChromeReloadOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.targetId || options.targetId.trim() === '') {
		output.writeWarn('targetId is required.')
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

	if (!target.webSocketDebuggerUrl) {
		output.writeWarn(`Target ${targetId} has no webSocketDebuggerUrl.`)
		process.exitCode = 1
		return
	}

	try {
		await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.reload' })
	} catch (error) {
		output.writeWarn(`Failed to reload target ${targetId}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ reloaded: targetId, url: target.url })
	} else {
		output.writeHuman(`reloaded ${targetId}`)
	}
}

export type ChromeListOptions = { json?: boolean; pages?: boolean }

export type ChromeInstanceInfo = {
	port: number
	pid: number
	browser: string
	webSocketDebuggerUrl: string
	targets: number
	pages: number
	pageDetails?: Array<{ title: string; url: string }>
}

/** Discover reachable Chrome instances with CDP enabled. */
export const discoverChromeInstances = async (options?: { pages?: boolean }): Promise<ChromeInstanceInfo[]> => {
	const ports = await discoverChromeCdpPorts()
	if (ports.length === 0) return []

	const results = await Promise.all(
		ports.map(async ({ port, pid }) => {
			try {
				const [version, targets] = await Promise.all([
					fetchJson<ChromeVersionResponse>(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 2_000 }),
					fetchJson<ChromeTargetResponse[]>(`http://127.0.0.1:${port}/json/list`, { timeoutMs: 2_000 }),
				])
				const userPages = targets.filter((t) => t.type === 'page' && isUserPage(t.url))
				return {
					port,
					pid,
					reachable: true as const,
					browser: version.Browser,
					webSocketDebuggerUrl: version.webSocketDebuggerUrl,
					targets: targets.length,
					pages: userPages.length,
					...(options?.pages && { pageDetails: userPages.map((p) => ({ title: p.title, url: p.url })) }),
				}
			} catch {
				return { port, pid, reachable: false as const }
			}
		}),
	)

	return results.filter((r): r is Extract<typeof r, { reachable: true }> => r.reachable)
}

/** Format a Chrome instance as a human-readable line. */
export const formatChromeInstanceLine = (r: ChromeInstanceInfo): string =>
	`127.0.0.1:${r.port} pid=${r.pid} ${r.browser} ${r.pages} page${r.pages === 1 ? '' : 's'}`

export const runChromeList = async (options: ChromeListOptions): Promise<void> => {
	const output = createOutput(options)

	const ports = await discoverChromeCdpPorts()
	if (ports.length === 0) {
		output.writeHuman('No Chrome instances found listening on TCP ports.')
		return
	}

	const instances = await discoverChromeInstances(options)

	if (instances.length === 0) {
		output.writeHuman('Found Chrome processes listening on TCP, but none responded to CDP.')
		return
	}

	if (options.json) {
		output.writeJson(instances)
	} else {
		for (const r of instances) {
			output.writeHuman(formatChromeInstanceLine(r))
			if (r.pageDetails) {
				for (const p of r.pageDetails) {
					output.writeHuman(`  ${p.title} — ${p.url}`)
				}
			}
		}
	}
}

/**
 * Chrome-internal URLs that CDP reports as `type: "page"` but are not user-visible tabs.
 * Covers omnibox popups, NTP sub-frames, side panels, and other top-chrome UI surfaces.
 */
const CHROME_INTERNAL_URL_PATTERN = /^(devtools|chrome-untrusted):\/\/|\.top-chrome\/|^chrome:\/\/newtab-footer\b/

/** Whether a CDP target URL represents a real user-visible page (tab). */
const isUserPage = (url: string): boolean => !CHROME_INTERNAL_URL_PATTERN.test(url)

/**
 * Match Chrome/Chromium process names in lsof output.
 * With `+c 0`, macOS lsof escapes spaces as `\x20` (e.g. `Google\x20Chrome`).
 */
const CHROME_NAME_PATTERN = /\b(google(\s|\\x20)*chrome|chromium|chrome)\b/i

/**
 * Discover Chrome processes listening on TCP ports via `lsof`.
 * Returns deduplicated `{ port, pid }` pairs.
 */
const discoverChromeCdpPorts = async (): Promise<Array<{ port: number; pid: number }>> => {
	let stdout: string
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			execFile('lsof', ['+c', '0', '-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: 5_000 }, (error, out) => {
				if (error) {
					reject(error)
					return
				}
				resolve(out)
			})
		})
	} catch {
		return []
	}

	const seen = new Set<number>()
	const results: Array<{ port: number; pid: number }> = []

	for (const line of stdout.split('\n')) {
		if (!CHROME_NAME_PATTERN.test(line)) {
			continue
		}

		// lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
		// With +c 0, COMMAND can contain escaped spaces — PID is the first purely numeric column.
		const pidMatch = line.match(/\s+(\d+)\s+/)
		if (!pidMatch) {
			continue
		}

		const pid = parseInt(pidMatch[1], 10)
		if (isNaN(pid)) {
			continue
		}

		// NAME column is last, format: *:PORT or 127.0.0.1:PORT (LISTEN)
		const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)
		if (!portMatch) {
			continue
		}

		const port = parseInt(portMatch[1], 10)
		if (isNaN(port) || seen.has(port)) {
			continue
		}

		seen.add(port)
		results.push({ port, pid })
	}

	return results
}
