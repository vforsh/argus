import type { IgnoreMatcher } from './ignoreList.js'
import type { LogEvent, WatcherMatch, WatcherChrome } from '@vforsh/argus-core'
import { createCdpSessionHandle } from './connection.js'
import type { CdpSessionController, CdpSessionHandle } from './connection.js'
import { fetchPageIntl, type PageIntlInfo, toConsoleEvent, toExceptionEvent } from './watcherEvents.js'
import { findTarget, type CdpTarget } from './watcherTargets.js'

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

/** Options for CDP watcher lifecycle. */
export type CdpWatcherOptions = {
	chrome: WatcherChrome
	match?: WatcherMatch
	onLog: (event: Omit<LogEvent, 'id'>) => void
	onStatus: (status: CdpStatus) => void
	onPageNavigation?: (info: { url: string; title: string | null }) => void
	onPageLoad?: () => void
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
	getTarget: () => CdpTarget | null
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

	session.onEvent('Page.domContentEventFired', () => {
		if (!currentTarget) {
			return
		}
		options.onPageLoad?.()
	})

	return {
		stop,
		session,
		getTarget: () => (currentTarget ? { ...currentTarget } : null),
	}

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
