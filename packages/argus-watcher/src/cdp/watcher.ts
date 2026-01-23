import type { LogEvent, LogLevel, WatcherMatch, WatcherChrome } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { IgnoreMatcher } from './ignoreList.js'
import { stripUrlPrefixes } from './locationCleanup.js'
import type { CallFrame, SelectedLocation } from './selectBestFrame.js'
import { selectBestFrame } from './selectBestFrame.js'
import { resolveSourcemappedLocation } from '../sourcemaps/resolveLocation.js'
import { createCdpSessionHandle } from './connection.js'
import type { CdpSessionController, CdpSessionHandle } from './connection.js'
import { serializeRemoteObject, serializeRemoteObjects } from './remoteObject.js'

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

	/** Target type (e.g., 'page', 'iframe', 'worker', 'service_worker'). */
	type: string

	/** Parent target ID for nested targets (e.g., iframes within pages). Null for top-level pages. */
	parentId: string | null
}

/** Current CDP attachment status. */
export type CdpStatus = {
	attached: boolean
	target: {
		title: string | null
		url: string | null
		type: string | null
		parentId: string | null
	} | null
	/** Best-effort reason for detachment. Null when attached. */
	reason?: string | null
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
	onAttach?: (session: CdpSessionHandle, target: CdpTarget) => Promise<void> | void
	onDetach?: (reason: string) => void
	sessionHandle?: CdpSessionController
	ignoreMatcher?: IgnoreMatcher | null
	stripUrlPrefixes?: string[]
}

export type CdpWatcherHandle = {
	session: CdpSessionHandle
	stop: () => Promise<void>
}

/** Start CDP polling + websocket subscriptions for console/exception events. */
export const startCdpWatcher = (options: CdpWatcherOptions): CdpWatcherHandle => {
	let stopped = false
	let socket: WebSocket | null = null
	let currentTarget: CdpTarget | null = null

	const { session, attach, detach } = options.sessionHandle ?? createCdpSessionHandle()

	const stop = async (): Promise<void> => {
		stopped = true
		if (socket) {
			socket.close()
		}
	}

	void runLoop()

	session.onEvent('Runtime.consoleAPICalled', (params) => {
		if (!currentTarget) {
			return
		}
		void toConsoleEvent(params, currentTarget, { ...options, cdp: session }).then((event) => options.onLog(event))
	})

	session.onEvent('Runtime.exceptionThrown', (params) => {
		if (!currentTarget) {
			return
		}
		void toExceptionEvent(params, currentTarget, { ...options, cdp: session }).then((event) => options.onLog(event))
	})

	session.onEvent('Page.frameNavigated', (params) => {
		if (!currentTarget) {
			return
		}
		const navigation = parseNavigation(params)
		if (!navigation) {
			return
		}
		currentTarget.url = navigation.url
		options.onPageNavigation?.({ url: navigation.url, title: currentTarget.title ?? null })
	})

	return { stop, session }

	async function runLoop(): Promise<void> {
		let backoffMs = 1_000
		while (!stopped) {
			try {
				await connectOnce()
				backoffMs = 1_000
			} catch (error) {
				const reason = `connect_failed: ${formatError(error)}`
				options.onLog(createSystemLog(`CDP connection failed: ${formatError(error)}`))
				options.onStatus({ attached: false, target: null, reason })
				options.onDetach?.(reason)
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

		const ws = socket
		const connection = attach(ws)
		currentTarget = target

		ws.addEventListener('message', (event) => {
			connection.handleMessage(event.data)
		})

		ws.addEventListener('close', () => {
			const reason = stopped ? 'stopped' : 'socket_closed'
			currentTarget = null
			detach(reason)
			options.onStatus({ attached: false, target: null, reason })
			options.onDetach?.(reason)
		})

		const pageIntl = await fetchPageIntl(session)
		if (pageIntl) {
			options.onPageIntl?.(pageIntl)
		}

		await session.sendAndWait('Runtime.enable')
		await session.sendAndWait('Page.enable')
		await options.onAttach?.(session, target)

		// Only signal attached after we've enabled the necessary domains
		options.onStatus({
			attached: true,
			target: {
				title: target.title ?? null,
				url: target.url ?? null,
				type: target.type ?? null,
				parentId: target.parentId ?? null,
			},
			reason: null,
		})

		await new Promise<void>((resolve) => {
			ws.addEventListener('close', () => resolve())
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

	// Direct target ID match bypasses all other filters
	if (match?.targetId) {
		const selected = targets.find((t) => t.id === match.targetId)
		if (!selected) {
			throw new Error(`No CDP target found with id: ${match.targetId}`)
		}
		return selected
	}

	const hasFilters = match?.url || match?.title || match?.urlRegex || match?.titleRegex || match?.type || match?.origin || match?.parent

	if (!match || !hasFilters) {
		return targets[0]
	}

	const urlRegex = match.urlRegex ? safeRegex(match.urlRegex) : null
	const titleRegex = match.titleRegex ? safeRegex(match.titleRegex) : null

	// Build a lookup map for parent resolution
	const targetById = new Map(targets.map((t) => [t.id, t]))

	const selected = targets.find((target) => {
		// Type filter (exact match)
		if (match.type && target.type !== match.type) {
			return false
		}

		// Origin filter (match URL origin only)
		if (match.origin) {
			const targetOrigin = extractOrigin(target.url)
			if (!targetOrigin || !targetOrigin.includes(match.origin)) {
				return false
			}
		}

		// Parent filter (match parent target's URL)
		if (match.parent) {
			if (!target.parentId) {
				return false
			}
			const parent = targetById.get(target.parentId)
			if (!parent || !parent.url.includes(match.parent)) {
				return false
			}
		}

		// URL substring filter
		if (match.url && !target.url.includes(match.url)) {
			return false
		}

		// Title substring filter
		if (match.title && !target.title.includes(match.title)) {
			return false
		}

		// URL regex filter
		if (urlRegex && !urlRegex.test(target.url)) {
			return false
		}

		// Title regex filter
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

/**
 * Extract the origin (protocol + host + port) from a URL.
 * Returns null if the URL is malformed.
 */
const extractOrigin = (url: string): string | null => {
	try {
		const parsed = new URL(url)
		return parsed.origin
	} catch {
		return null
	}
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
			type: String(target.type ?? 'page'),
			parentId: typeof target.parentId === 'string' ? target.parentId : null,
		}))
		.filter((target) => Boolean(target.webSocketDebuggerUrl))
}

const toConsoleEvent = async (
	params: unknown,
	target: CdpTarget,
	config: { ignoreMatcher?: IgnoreMatcher | null; stripUrlPrefixes?: string[]; cdp?: CdpSessionHandle },
): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		type?: LogLevel
		args?: unknown[]
		stackTrace?: { callFrames?: CallFrame[] }
	}
	const cdp = config.cdp
	const runtimeClient = cdp ? { sendAndWait: (method: string, params?: Record<string, unknown>) => cdp.sendAndWait(method, params) } : undefined
	const args = Array.isArray(record.args) ? await serializeRemoteObjects(record.args, runtimeClient) : []
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
	config: { ignoreMatcher?: IgnoreMatcher | null; stripUrlPrefixes?: string[]; cdp?: CdpSessionHandle },
): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		exceptionDetails?: {
			text?: string
			exception?: unknown
			stackTrace?: { callFrames?: CallFrame[] }
		}
	}
	const details = record.exceptionDetails
	const cdp = config.cdp
	const runtimeClient = cdp ? { sendAndWait: (method: string, params?: Record<string, unknown>) => cdp.sendAndWait(method, params) } : undefined
	const exceptionValue = details?.exception ? await serializeRemoteObject(details.exception, runtimeClient) : null
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

const fetchPageIntl = async (session: CdpSessionHandle): Promise<PageIntlInfo | null> => {
	try {
		const result = await session.sendAndWait('Runtime.evaluate', {
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
