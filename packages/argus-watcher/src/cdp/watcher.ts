import type { IgnoreMatcher } from './ignoreList.js'
import type { LogEvent, WatcherMatch, WatcherChrome } from '@vforsh/argus-core'
import { formatError } from '@vforsh/argus-core'
import { createCdpSessionHandle } from './connection.js'
import type { CdpSessionController, CdpSessionHandle } from './connection.js'
import { fetchPageIntl, type PageIntlInfo, toConsoleEvent, toExceptionEvent } from './watcherEvents.js'
import { tryEvaluateInPage } from './pageState.js'
import { findTarget, type CdpTarget } from './watcherTargets.js'
import type { SourcemapResolver } from '../sourcemaps/sourcemapResolver.js'
import { delay } from '@vforsh/argus-core'

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
	sourcemaps: SourcemapResolver
}

export type CdpWatcherHandle = {
	session: CdpSessionHandle
	stop: () => Promise<void>
	getTarget: () => CdpTarget | null
	/**
	 * Drop the current socket so the connect loop re-selects a target.
	 *
	 * The only way back from a target Chrome has replaced under us: the loop already reconnects on
	 * socket close, and `findTarget` re-runs the match, so closing is the whole reattachment.
	 */
	reconnect: () => void
}

/** Start CDP polling + websocket subscriptions for console/exception events. */
export const startCdpWatcher = (options: CdpWatcherOptions): CdpWatcherHandle => {
	let stopped = false
	let socket: WebSocket | null = null
	let currentTarget: CdpTarget | null = null
	/** Top frame of the attached page, so iframe navigation events cannot be mistaken for the page's. */
	let topFrameId: string | null = null

	const { session, attach, detach } = options.sessionHandle ?? createCdpSessionHandle()

	const stop = async (): Promise<void> => {
		stopped = true
		if (socket) {
			socket.close()
		}
	}

	const reconnect = (): void => {
		if (stopped) {
			return
		}
		socket?.close()
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
		topFrameId = navigation.frameId ?? topFrameId
		currentTarget.url = navigation.url
		// The status snapshot is the watcher's public answer to "where is the page" — it backs
		// `argus page url`, relative URL resolution in /navigate, and the indicator. Emitting only
		// on attach left it frozen at whatever URL the target had when the socket opened.
		emitAttachedStatus()
		options.onPageNavigation?.({ url: navigation.url, title: currentTarget.title ?? null })
	})

	session.onEvent('Page.navigatedWithinDocument', (params) => {
		if (!currentTarget || !params.url || (topFrameId != null && params.frameId !== topFrameId)) {
			return
		}
		// Same-document: the URL changed but the document did not. Deliberately not a page
		// navigation — rotating logs and dropping sourcemaps for a hash change would be wrong.
		currentTarget.url = params.url
		emitAttachedStatus()
	})

	session.onEvent('Page.domContentEventFired', () => {
		if (!currentTarget) {
			return
		}
		// The new document's title does not exist yet at frameNavigated time; refresh it once the
		// DOM is parsed so status does not report the previous page's title against the new URL.
		void refreshTargetTitle()
		options.onPageLoad?.()
	})

	return {
		stop,
		reconnect,
		session,
		getTarget: () => (currentTarget ? { ...currentTarget } : null),
	}

	/** Publish the current target as an attached status. No-op before the first attach. */
	function emitAttachedStatus(): void {
		if (!currentTarget) {
			return
		}
		options.onStatus({
			attached: true,
			target: {
				title: currentTarget.title ?? null,
				url: currentTarget.url ?? null,
				type: currentTarget.type ?? null,
				parentId: currentTarget.parentId ?? null,
			},
			reason: null,
		})
	}

	/** Best-effort title refresh after a navigation. A failed read leaves the old title in place. */
	async function refreshTargetTitle(): Promise<void> {
		const target = currentTarget
		if (!target) {
			return
		}
		const title = await tryEvaluateInPage<string>(session, 'document.title')
		if (typeof title !== 'string' || target !== currentTarget || target.title === title) {
			return
		}
		target.title = title
		emitAttachedStatus()
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
			topFrameId = null
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
		// Learn the top frame up front; without it a hash change in an iframe would overwrite the
		// page's URL before the first top-frame navigation ever names it.
		const frameTree = await session.sendAndWait('Page.getFrameTree').catch(() => null)
		topFrameId = frameTree?.frameTree?.frame.id ?? null
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

const parseNavigation = (params: unknown): { url: string; frameId?: string } | null => {
	const record = params as { frame?: { id?: string; url?: string; parentId?: string | null } }
	const url = record.frame?.url
	if (!url || typeof url !== 'string' || url.trim() === '') {
		return null
	}
	if (record.frame?.parentId) {
		return null
	}
	return { url, frameId: record.frame?.id }
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
