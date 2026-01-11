import type { LogEvent, LogLevel, WatcherMatch, WatcherChrome } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { IgnoreMatcher } from './ignoreList.js'
import { stripUrlPrefixes } from './locationCleanup.js'
import type { CallFrame, SelectedLocation } from './selectBestFrame.js'
import { selectBestFrame } from './selectBestFrame.js'
import { resolveSourcemappedLocation } from '../sourcemaps/resolveLocation.js'

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

type PageIntlInfo = {
	timezone: string | null
	locale: string | null
}

/** Options for CDP watcher lifecycle. */
export type CdpWatcherOptions = {
	chrome: WatcherChrome
	match?: WatcherMatch
	onLog: (event: Omit<LogEvent, 'id'>) => void
	onStatus: (status: CdpStatus) => void
	onPageNavigation?: (info: { url: string; title: string | null }) => void
	onPageIntl?: (info: PageIntlInfo) => void
	ignoreMatcher?: IgnoreMatcher | null
	stripUrlPrefixes?: string[]
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
		const pendingRequests = new Map<number, PendingRequest>()

		socket = new WebSocket(target.webSocketDebuggerUrl)
		await new Promise<void>((resolve, reject) => {
			socket?.addEventListener('open', () => resolve())
			socket?.addEventListener('error', () => reject(new Error('WebSocket error')))
		})

		if (!socket) {
			throw new Error('WebSocket unavailable')
		}

		const ws = socket
		const cdp: CdpClient = {
			sendAndWait: async (method, params) => sendAndWait(ws, pendingRequests, method, params),
		}

		socket.addEventListener('message', (event) => {
			const message = parseMessage(event.data)
			if (!message || typeof message !== 'object') {
				return
			}

			const payload = message as {
				id?: number
				result?: unknown
				error?: { message?: string } | null
				method?: string
				params?: unknown
			}
			if (payload.id != null) {
				const pending = pendingRequests.get(payload.id)
				if (!pending) {
					return
				}
				pendingRequests.delete(payload.id)
				if (payload.error) {
					pending.reject(new Error(payload.error.message ?? 'CDP request failed'))
					return
				}
				pending.resolve(payload.result)
				return
			}
			if (payload.method === 'Runtime.consoleAPICalled') {
				void toConsoleEvent(payload.params, target, { ...options, cdp }).then((event) => options.onLog(event))
				return
			}
			if (payload.method === 'Runtime.exceptionThrown') {
				void toExceptionEvent(payload.params, target, { ...options, cdp }).then((event) => options.onLog(event))
				return
			}
			if (payload.method === 'Page.frameNavigated') {
				const navigation = parseNavigation(payload.params)
				if (!navigation) {
					return
				}
				target.url = navigation.url
				options.onPageNavigation?.({ url: navigation.url, title: target.title ?? null })
			}
		})

		socket.addEventListener('close', () => {
			options.onStatus({ attached: false, target: null })
		})

		const pageIntl = await fetchPageIntl(socket, pendingRequests)
		if (pageIntl) {
			options.onPageIntl?.(pageIntl)
		}

		await sendAndWait(socket, pendingRequests, 'Runtime.enable')
		await sendAndWait(socket, pendingRequests, 'Page.enable')

		// Only signal attached after we've enabled the necessary domains
		options.onStatus({ attached: true, target: { title: target.title ?? null, url: target.url ?? null } })

		await new Promise<void>((resolve) => {
			socket?.addEventListener('close', () => resolve())
		})
	}
}

const parseNavigation = (params: unknown): { url: string } | null => {
	const record = params as { frame?: { url?: string; parentId?: string | null } }
	const url = record.frame?.url
	if (!url || typeof url !== 'string' || url.trim() === '') {
		return null
	}
	if (record.frame?.parentId) {
		return null
	}
	return { url }
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

const toConsoleEvent = async (
	params: unknown,
	target: CdpTarget,
	config: { ignoreMatcher?: IgnoreMatcher | null; stripUrlPrefixes?: string[]; cdp?: CdpClient },
): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		type?: LogLevel
		args?: unknown[]
		stackTrace?: { callFrames?: CallFrame[] }
	}
	const args = Array.isArray(record.args) ? await serializeRemoteObjects(record.args, config.cdp) : []
	const text = formatArgs(args)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'console',
	}

	const selected = await selectLocationFromFrames(record.stackTrace?.callFrames, config.ignoreMatcher ?? null)
	if (selected) {
		return applyLocationCleanup({ ...baseEvent, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(baseEvent, record.stackTrace?.callFrames))
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
}

const toExceptionEvent = async (
	params: unknown,
	target: CdpTarget,
	config: { ignoreMatcher?: IgnoreMatcher | null; stripUrlPrefixes?: string[]; cdp?: CdpClient },
): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		exceptionDetails?: {
			text?: string
			exception?: unknown
			stackTrace?: { callFrames?: CallFrame[] }
		}
	}
	const details = record.exceptionDetails
	const exceptionValue = details?.exception ? await serializeRemoteObject(details.exception, config.cdp) : null
	const args = exceptionValue != null ? [exceptionValue] : []
	const exceptionDescription = describeExceptionValue(exceptionValue)
	const text = formatExceptionText(details?.text, exceptionDescription)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: Date.now(),
		level: 'exception',
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'exception',
	}

	const selected = await selectLocationFromFrames(details?.stackTrace?.callFrames, config.ignoreMatcher ?? null)
	if (selected) {
		return applyLocationCleanup({ ...baseEvent, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(baseEvent, details?.stackTrace?.callFrames))
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
}

const applySourcemap = async (event: Omit<LogEvent, 'id'>): Promise<Omit<LogEvent, 'id'>> => {
	if (!event.file || event.line == null || event.column == null) {
		return event
	}
	try {
		const resolved = await resolveSourcemappedLocation({
			file: event.file,
			line: event.line,
			column: event.column,
		})
		if (!resolved) {
			return event
		}
		return {
			...event,
			file: resolved.file,
			line: resolved.line,
			column: resolved.column,
		}
	} catch {
		return event
	}
}

const selectLocationFromFrames = async (
	callFrames: CallFrame[] | undefined,
	ignoreMatcher: IgnoreMatcher | null,
): Promise<SelectedLocation | null> => {
	if (!ignoreMatcher) {
		return null
	}
	return selectBestFrame(callFrames, ignoreMatcher)
}

const applyFirstFrame = (event: Omit<LogEvent, 'id'>, callFrames: CallFrame[] | undefined): Omit<LogEvent, 'id'> => {
	const frame = callFrames?.[0]
	const file = frame?.url ?? null
	const line = frame?.lineNumber != null ? frame.lineNumber + 1 : null
	const column = frame?.columnNumber != null ? frame.columnNumber + 1 : null
	return { ...event, file, line, column }
}

const applyLocationCleanup = (event: Omit<LogEvent, 'id'>, prefixes: string[] | undefined): Omit<LogEvent, 'id'> => {
	if (!event.file) {
		return event
	}
	const cleaned = stripUrlPrefixes(event.file, prefixes)
	if (cleaned === event.file) {
		return event
	}
	return { ...event, file: cleaned }
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

type CdpClient = {
	sendAndWait: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

type RemoteObjectRecord = {
	type?: string
	subtype?: string
	value?: unknown
	unserializableValue?: string
	description?: string
	preview?: { properties?: Array<{ name: string; value?: string }> }
	objectId?: string
}

const serializeRemoteObjects = async (values: unknown[], cdp?: CdpClient): Promise<unknown[]> => {
	if (!cdp) {
		return values.map((value) => serializeRemoteObjectSync(value))
	}
	return Promise.all(values.map((value) => serializeRemoteObject(value, cdp)))
}

const serializeRemoteObject = async (value: unknown, cdp?: CdpClient): Promise<unknown> => {
	if (!value || typeof value !== 'object') {
		return value
	}

	const record = value as RemoteObjectRecord

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

	if (cdp && record.objectId && record.type === 'object') {
		const expanded = await expandRemoteObjectViaGetProperties(record, cdp)
		if (expanded) {
			return expanded
		}
	}

	return record.description ?? record.subtype ?? record.type ?? 'Object'
}

const serializeRemoteObjectSync = (value: unknown): unknown => {
	if (!value || typeof value !== 'object') {
		return value
	}

	const record = value as RemoteObjectRecord

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

const expandRemoteObjectViaGetProperties = async (record: RemoteObjectRecord, cdp: CdpClient): Promise<Record<string, unknown> | null> => {
	if (!record.objectId) {
		return null
	}

	let result: unknown
	try {
		result = await cdp.sendAndWait('Runtime.getProperties', {
			objectId: record.objectId,
			ownProperties: true,
			accessorPropertiesOnly: false,
		})
	} catch {
		return null
	}

	const payload = result as { result?: Array<{ name?: unknown; value?: unknown }> }
	if (!Array.isArray(payload.result) || payload.result.length === 0) {
		return null
	}

	const out: Record<string, unknown> = {}
	const limit = 50
	let added = 0
	for (const prop of payload.result) {
		if (added >= limit) {
			out['…'] = `+${payload.result.length - limit} more`
			break
		}

		const name = prop?.name
		if (typeof name !== 'string' || name.trim() === '' || name === '__proto__') {
			continue
		}

		// Keep this shallow and deterministic: use CDP-provided scalar values/previews/descriptions,
		// but don't recursively expand nested objects (that can be expensive and/or cyclic).
		out[name] = serializeRemoteObjectSync(prop.value)
		added += 1
	}

	if (Object.keys(out).length === 0) {
		return null
	}

	return out
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

	return args.map((arg) => previewStringify(arg)).join(' ')
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

type PendingRequest = {
	resolve: (result: unknown) => void
	reject: (error: Error) => void
}

let nextId = 1
const sendAndWait = (
	socket: WebSocket,
	pendingRequests: Map<number, PendingRequest>,
	method: string,
	params?: Record<string, unknown>,
): Promise<unknown> => {
	const id = nextId++
	return new Promise((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject })
		try {
			socket.send(JSON.stringify({ id, method, params }))
		} catch (error) {
			pendingRequests.delete(id)
			reject(error instanceof Error ? error : new Error(String(error)))
		}
	})
}

const fetchPageIntl = async (socket: WebSocket, pendingRequests: Map<number, PendingRequest>): Promise<PageIntlInfo | null> => {
	try {
		const result = await sendAndWait(socket, pendingRequests, 'Runtime.evaluate', {
			expression:
				'(() => { const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; const locale = navigator.language ?? null; return { timezone, locale }; })()',
			returnByValue: true,
		})
		const payload = result as { result?: { value?: { timezone?: unknown; locale?: unknown } } }
		const value = payload.result?.value
		if (!value || typeof value !== 'object') {
			return null
		}
		const record = value as { timezone?: unknown; locale?: unknown }
		const timezone = typeof record.timezone === 'string' && record.timezone.trim() !== '' ? record.timezone : null
		const locale = typeof record.locale === 'string' && record.locale.trim() !== '' ? record.locale : null
		return { timezone, locale }
	} catch {
		return null
	}
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
