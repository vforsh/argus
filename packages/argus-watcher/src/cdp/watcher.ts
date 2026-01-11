import type { LogEvent, LogLevel, WatcherMatch, WatcherChrome } from '@vforsh/argus-core'

/** Minimal CDP target metadata needed for attachment. */
export type CdpTarget = {
	/** CDP target id (from Chrome `/json` endpoint). */
	id: string

	/** Human-readable page title for the target. */
	title: string

	/** Page URL for the target. */
	url: string

	/** WebSocket URL used to connect to the target via the Chrome DevTools Protocol. */
	webSocketDebuggerUrl: string
}

/** Current CDP attachment status. */
export type CdpStatus = {
	attached: boolean
	target: {
		title: string | null
		url: string | null
	} | null
}

/** Options for CDP watcher lifecycle. */
export type CdpWatcherOptions = {
	chrome: WatcherChrome
	match?: WatcherMatch
	onLog: (event: Omit<LogEvent, 'id'>) => void
	onStatus: (status: CdpStatus) => void
}

/** Start CDP polling + websocket subscriptions for console/exception events. */
export const startCdpWatcher = (options: CdpWatcherOptions): { stop: () => Promise<void> } => {
	let stopped = false
	let socket: WebSocket | null = null

	const stop = async (): Promise<void> => {
		stopped = true
		if (socket) {
			socket.close()
		}
	}

	void runLoop()

	return { stop }

	async function runLoop(): Promise<void> {
		let backoffMs = 1_000
		while (!stopped) {
			try {
				await connectOnce()
				backoffMs = 1_000
			} catch (error) {
				options.onLog(createSystemLog(`CDP connection failed: ${formatError(error)}`))
				options.onStatus({ attached: false, target: null })
				await delay(backoffMs)
				backoffMs = Math.min(backoffMs * 2, 10_000)
			}
		}
	}

	async function connectOnce(): Promise<void> {
		const target = await findTarget(options.chrome, options.match)

		socket = new WebSocket(target.webSocketDebuggerUrl)
		await new Promise<void>((resolve, reject) => {
			socket?.addEventListener('open', () => resolve())
			socket?.addEventListener('error', () => reject(new Error('WebSocket error')))
		})

		if (!socket) {
			throw new Error('WebSocket unavailable')
		}

		socket.addEventListener('message', (event) => {
			const message = parseMessage(event.data)
			if (!message || typeof message !== 'object') {
				return
			}

			const payload = message as { method?: string; params?: unknown }
			if (payload.method === 'Runtime.consoleAPICalled') {
				options.onLog(toConsoleEvent(payload.params, target))
				return
			}
			if (payload.method === 'Runtime.exceptionThrown') {
				options.onLog(toExceptionEvent(payload.params, target))
			}
		})

		socket.addEventListener('close', () => {
			options.onStatus({ attached: false, target: null })
		})

		send(socket, 'Runtime.enable')
		send(socket, 'Page.enable')

		// Only signal attached after we've enabled the necessary domains
		options.onStatus({ attached: true, target: { title: target.title ?? null, url: target.url ?? null } })

		await new Promise<void>((resolve) => {
			socket?.addEventListener('close', () => resolve())
		})
	}
}

const findTarget = async (chrome: WatcherChrome, match?: WatcherMatch): Promise<CdpTarget> => {
	const targets = await fetchTargets(chrome)
	if (targets.length === 0) {
		throw new Error('No CDP targets available')
	}

	if (!match || (!match.url && !match.title && !match.urlRegex && !match.titleRegex)) {
		return targets[0]
	}

	const urlRegex = match.urlRegex ? safeRegex(match.urlRegex) : null
	const titleRegex = match.titleRegex ? safeRegex(match.titleRegex) : null

	const selected = targets.find((target) => {
		if (match.url && !target.url.includes(match.url)) {
			return false
		}
		if (match.title && !target.title.includes(match.title)) {
			return false
		}
		if (urlRegex && !urlRegex.test(target.url)) {
			return false
		}
		if (titleRegex && !titleRegex.test(target.title)) {
			return false
		}
		return true
	})

	if (!selected) {
		throw new Error('No CDP target matched the provided criteria')
	}

	return selected
}

const fetchTargets = async (chrome: WatcherChrome): Promise<CdpTarget[]> => {
	const response = await fetch(`http://${chrome.host}:${chrome.port}/json`)
	if (!response.ok) {
		throw new Error(`Failed to fetch CDP targets (status ${response.status})`)
	}

	const data = await response.json()
	if (!Array.isArray(data)) {
		throw new Error('CDP target list is not an array')
	}

	return data
		.map((target) => ({
			id: target.id as string,
			title: String(target.title ?? ''),
			url: String(target.url ?? ''),
			webSocketDebuggerUrl: String(target.webSocketDebuggerUrl ?? ''),
		}))
		.filter((target) => Boolean(target.webSocketDebuggerUrl))
}

const toConsoleEvent = (params: unknown, target: CdpTarget): Omit<LogEvent, 'id'> => {
	const record = params as {
		type?: LogLevel
		args?: unknown[]
		stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> }
	}
	const args = Array.isArray(record.args) ? record.args.map(serializeRemoteObject) : []
	const text = formatArgs(args)
	const frame = record.stackTrace?.callFrames?.[0]
	const file = frame?.url ?? null
	const line = frame?.lineNumber != null ? frame.lineNumber + 1 : null
	const column = frame?.columnNumber != null ? frame.columnNumber + 1 : null

	return {
		ts: Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		file,
		line,
		column,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'console',
	}
}

const toExceptionEvent = (params: unknown, target: CdpTarget): Omit<LogEvent, 'id'> => {
	const record = params as {
		exceptionDetails?: {
			text?: string
			exception?: unknown
			stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> }
		}
	}
	const details = record.exceptionDetails
	const exceptionValue = details?.exception ? serializeRemoteObject(details.exception) : null
	const args = exceptionValue != null ? [exceptionValue] : []
	const exceptionDescription = describeExceptionValue(exceptionValue)
	const text = formatExceptionText(details?.text, exceptionDescription)
	const frame = details?.stackTrace?.callFrames?.[0]
	const file = frame?.url ?? null
	const line = frame?.lineNumber != null ? frame.lineNumber + 1 : null
	const column = frame?.columnNumber != null ? frame.columnNumber + 1 : null

	return {
		ts: Date.now(),
		level: 'exception',
		text,
		args,
		file,
		line,
		column,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'exception',
	}
}

const describeExceptionValue = (value: unknown): string | null => {
	if (value == null) {
		return null
	}

	if (typeof value === 'string') {
		return value
	}

	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

const formatExceptionText = (baseText: string | undefined, description: string | null): string => {
	const trimmed = baseText?.trim()
	if (!trimmed) {
		return description ?? 'Exception'
	}

	if (!description) {
		return trimmed
	}

	const isGeneric = trimmed === 'Uncaught' || trimmed === 'Uncaught (in promise)'
	if (isGeneric && !trimmed.includes(description)) {
		return `${trimmed}: ${description}`
	}

	return trimmed
}

const serializeRemoteObject = (value: unknown): unknown => {
	if (!value || typeof value !== 'object') {
		return value
	}

	const record = value as {
		type?: string
		subtype?: string
		value?: unknown
		unserializableValue?: string
		description?: string
		preview?: { properties?: Array<{ name: string; value?: string }> }
	}

	if (record.unserializableValue) {
		return record.unserializableValue
	}

	if (record.value !== undefined) {
		return record.value
	}

	if (record.preview?.properties) {
		const preview: Record<string, string> = {}
		for (const prop of record.preview.properties) {
			preview[prop.name] = prop.value ?? ''
		}
		return preview
	}

	return record.description ?? record.subtype ?? record.type ?? 'Object'
}

const normalizeLevel = (level: LogLevel | string): LogLevel => {
	if (level === 'warn') {
		return 'warning'
	}

	if (level === 'warning') {
		return 'warning'
	}

	if (level === 'error' || level === 'info' || level === 'debug' || level === 'exception' || level === 'log') {
		return level
	}

	return 'log'
}

const formatArgs = (args: unknown[]): string => {
	if (args.length === 0) {
		return ''
	}

	return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
}

const parseMessage = (data: unknown): unknown => {
	if (typeof data === 'string') {
		try {
			return JSON.parse(data)
		} catch {
			return null
		}
	}

	if (data instanceof ArrayBuffer) {
		return parseMessage(new TextDecoder().decode(data))
	}

	return null
}

let nextId = 1
const send = (socket: WebSocket, method: string): void => {
	socket.send(JSON.stringify({ id: nextId++, method }))
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const safeRegex = (pattern: string): RegExp => {
	try {
		return new RegExp(pattern)
	} catch {
		throw new Error(`Invalid regex pattern: ${pattern}`)
	}
}

const createSystemLog = (message: string): Omit<LogEvent, 'id'> => ({
	ts: Date.now(),
	level: 'warning',
	text: message,
	args: [],
	file: null,
	line: null,
	column: null,
	pageUrl: null,
	pageTitle: null,
	source: 'system',
})

const formatError = (error: unknown): string => {
	if (!error) {
		return 'Unknown error'
	}

	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}
