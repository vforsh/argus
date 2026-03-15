/**
 * Extension source for CDP access via Chrome extension Native Messaging.
 * Wraps SessionManager and provides a unified source interface.
 */

import type { LogEvent, LogLevel } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { TabInfo } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpSessionHandle, CdpTargetContext } from '../cdp/connection.js'

/**
 * Options for creating an extension source.
 */
export type ExtensionSourceOptions = CdpSourceBaseOptions

/**
 * Create an extension source that connects to Chrome via Native Messaging.
 * Returns a handle that can be used to control the source and access CDP session.
 */
export const createExtensionSource = (options: ExtensionSourceOptions): CdpSourceHandle => {
	const { events, ignoreMatcher, stripUrlPrefixes, watcherId, watcherHost, watcherPort } = options

	const messaging = createNativeMessaging()
	const hostInfo = {
		watcherId: watcherId ?? 'extension',
		watcherHost: watcherHost ?? '127.0.0.1',
		watcherPort: watcherPort ?? 0,
		watcherPid: process.pid,
	}
	let currentSession: ExtensionSession | null = null
	let stopping = false
	const frameStateByTabId = new Map<number, ExtensionFrameState>()
	const pendingSelectionByTabId = new Map<number, string | null>()
	const getCurrentExtensionSession = (): ExtensionSession => {
		if (!currentSession) {
			throw createNotAttachedError()
		}
		return currentSession
	}

	const sessionManager = new SessionManager(messaging, {
		onAttach: (session: ExtensionSession) => {
			console.error(`[ExtensionSource] Tab attached: ${session.tabId} - ${session.url}`)

			currentSession = session
			frameStateByTabId.set(session.tabId, createEmptyFrameState())
			void bootstrapAttachedSession(session)
		},

		onDetach: (tabId: number, reason: string) => {
			console.error(`[ExtensionSource] Tab detached: ${tabId} - ${reason}`)

			if (currentSession?.tabId === tabId) {
				currentSession = null
			}
			frameStateByTabId.delete(tabId)
			pendingSelectionByTabId.delete(tabId)

			emitStatus(null, reason)

			events.onDetach?.(reason)
		},

		onTabsUpdated: () => {
			// Tabs list updated - no action needed
		},

		onTargetSelected: (tabId, frameId) => {
			const session = currentSession
			if (!session || session.tabId !== tabId) {
				pendingSelectionByTabId.set(tabId, frameId)
				return
			}
			selectTargetSafely(session, frameId, 'target')
		},
	})

	// Proxy session follows the currently selected page/frame target inside the attached tab.
	const proxySession = createDelegatingSession({
		getTargetContext: () => getCurrentTargetContext() ?? { kind: 'page' },
		mapParams: (method, params) => {
			const targetContext = getCurrentTargetContext()
			if (method !== 'Runtime.evaluate' || targetContext?.kind !== 'frame' || params?.contextId != null) {
				return params
			}
			if (targetContext.executionContextId == null) {
				throw new Error(`Selected frame is not ready yet: ${targetContext.frameId}`)
			}
			return {
				...(params ?? {}),
				contextId: targetContext.executionContextId,
			}
		},
	})

	// Page session always stays at the top-level tab context so page-level features
	// (indicator, inject-on-attach, similar lifecycle hooks) don't accidentally run inside an iframe.
	const pageSession = createDelegatingSession({
		getTargetContext: () => ({ kind: 'page' }),
	})

	messaging.start()
	sendHostInfo()
	messaging.onDisconnect(() => {
		console.error('[ExtensionSource] Extension disconnected')
		if (!stopping) {
			emitStatus(null, 'extension_disconnected')
			events.onDetach?.('extension_disconnected')
		}
	})

	const stop = async (): Promise<void> => {
		stopping = true
		messaging.stop()
	}

	const listTargets = async (): Promise<CdpSourceTarget[]> => {
		const tabs = await sessionManager.listTabs()
		return tabs.flatMap((tab) => {
			const session = currentSession?.tabId === tab.tabId ? currentSession : null
			const state = frameStateByTabId.get(tab.tabId)
			if (!session || !state || state.frames.size === 0) {
				return [tabToTarget(tab)]
			}

			const selectedFrameId = state.selectedFrameId
			const targets: CdpSourceTarget[] = [buildPageTarget(session, { attached: selectedFrameId == null })]
			for (const frame of buildFrameTargets(state, tab.tabId, selectedFrameId, tab.faviconUrl)) {
				targets.push(frame)
			}
			return targets
		})
	}

	const attachTarget = (targetId: string): void => {
		const target = parseExtensionTargetId(targetId)
		const session = currentSession
		if (!session || session.tabId !== target.tabId) {
			pendingSelectionByTabId.set(target.tabId, target.frameId)
			sessionManager.attachTab(target.tabId)
			return
		}

		selectTarget(session, target.frameId)
	}

	const detachTarget = (targetId: string): void => {
		sessionManager.detachTab(parseExtensionTargetId(targetId).tabId)
	}

	return {
		session: proxySession,
		pageSession,
		syncWatcherInfo: (info) => {
			hostInfo.watcherId = info.watcherId
			hostInfo.watcherHost = info.watcherHost
			hostInfo.watcherPort = info.watcherPort
			hostInfo.watcherPid = info.watcherPid
			sendHostInfo()
		},
		stop,
		listTargets,
		attachTarget,
		detachTarget,
	}

	function sendHostInfo(): void {
		messaging.send({
			type: 'host_info',
			watcherId: hostInfo.watcherId,
			watcherHost: hostInfo.watcherHost,
			watcherPort: hostInfo.watcherPort,
			pid: hostInfo.watcherPid,
		})
	}

	async function bootstrapAttachedSession(session: ExtensionSession): Promise<void> {
		try {
			registerSessionEventHandlers(session)
			await enableBootstrapDomains(session)
			await refreshFrameTree(session)

			if (currentSession?.tabId !== session.tabId) {
				return
			}

			const target = buildPageTarget(session, { attached: true })
			emitStatus(target, null)
			await events.onAttach?.(session.handle, target)
			restorePendingSelection(session)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`[ExtensionSource] Failed to bootstrap attached tab ${session.tabId}: ${message}`)

			if (currentSession?.tabId === session.tabId) {
				emitStatus(null, message)
				events.onDetach?.(message)
			}
		}
	}

	/**
	 * Subscribe before enabling Runtime/Page so we don't miss the initial execution contexts
	 * that Chrome emits as soon as Runtime becomes active.
	 */
	async function enableBootstrapDomains(session: ExtensionSession): Promise<void> {
		await session.handle.sendAndWait('Runtime.enable')
		await session.handle.sendAndWait('Page.enable')
	}

	function restorePendingSelection(session: ExtensionSession): void {
		const pendingFrameId = pendingSelectionByTabId.get(session.tabId)
		if (pendingFrameId !== undefined) {
			pendingSelectionByTabId.delete(session.tabId)
			selectTargetSafely(session, pendingFrameId, 'pending frame')
			return
		}

		emitTargetChanged(session)
	}

	function registerSessionEventHandlers(session: ExtensionSession): void {
		session.handle.onEvent('Runtime.executionContextCreated', (params) => {
			const context = parseExecutionContext(params)
			if (!context?.isDefault || !context.frameId) {
				return
			}
			const state = getOrCreateFrameState(session.tabId)
			state.executionContexts.set(context.frameId, context.id)
			void refreshFrameTitle(session, context.frameId, context.id)
			emitTargetChanged(session)
		})

		session.handle.onEvent('Runtime.executionContextsCleared', () => {
			const state = getOrCreateFrameState(session.tabId)
			state.executionContexts.clear()
			state.pendingTitleLoads.clear()
		})

		session.handle.onEvent('Runtime.executionContextDestroyed', (params) => {
			const record = params as { executionContextId?: number }
			if (record.executionContextId == null) {
				return
			}

			const state = getOrCreateFrameState(session.tabId)
			for (const [frameId, contextId] of state.executionContexts.entries()) {
				if (contextId === record.executionContextId) {
					state.executionContexts.delete(frameId)
					state.pendingTitleLoads.delete(frameId)
				}
			}
		})

		session.handle.onEvent('Page.frameNavigated', (params) => {
			const frame = parseFrame(params)
			if (!frame) {
				return
			}

			const state = getOrCreateFrameState(session.tabId)
			state.frames.set(frame.frameId, frame)
			if (!frame.parentFrameId) {
				state.topFrameId = frame.frameId
				session.url = frame.url
			} else if (state.executionContexts.has(frame.frameId)) {
				void refreshFrameTitle(session, frame.frameId)
			}
			currentSession = session

			if (!frame.parentFrameId) {
				events.onPageNavigation?.({ url: frame.url, title: session.title ?? null })
			}

			if ((!frame.parentFrameId && state.selectedFrameId == null) || state.selectedFrameId === frame.frameId) {
				emitTargetChanged(session)
			}
		})

		session.handle.onEvent('Page.frameAttached', (params) => {
			const record = params as { frameId?: string; parentFrameId?: string }
			if (!record.frameId) {
				return
			}
			const state = getOrCreateFrameState(session.tabId)
			state.frames.set(record.frameId, {
				frameId: record.frameId,
				parentFrameId: record.parentFrameId ?? state.topFrameId ?? null,
				url: '',
				title: null,
			})
		})

		session.handle.onEvent('Page.frameDetached', (params) => {
			const record = params as { frameId?: string }
			if (!record.frameId) {
				return
			}
			removeFrame(session.tabId, record.frameId)
			const state = getOrCreateFrameState(session.tabId)
			if (state.selectedFrameId === record.frameId) {
				state.selectedFrameId = null
				state.selectedAttachedAt = Date.now()
				emitTargetChanged(session)
			}
		})

		session.handle.onEvent('Page.domContentEventFired', () => {
			events.onPageLoad?.()
		})

		session.handle.onEvent('Runtime.consoleAPICalled', (params) => {
			events.onLog(toConsoleEvent(params, session, { ignoreMatcher, stripUrlPrefixes }))
		})

		session.handle.onEvent('Runtime.exceptionThrown', (params) => {
			events.onLog(toExceptionEvent(params, session, { ignoreMatcher, stripUrlPrefixes }))
		})
	}

	function getCurrentTargetContext(): CdpTargetContext | null {
		const session = currentSession
		if (!session) {
			return null
		}

		const state = frameStateByTabId.get(session.tabId)
		if (!state?.selectedFrameId) {
			return { kind: 'page' }
		}

		return {
			kind: 'frame',
			frameId: state.selectedFrameId,
			executionContextId: state.executionContexts.get(state.selectedFrameId) ?? null,
		}
	}

	function getOrCreateFrameState(tabId: number): ExtensionFrameState {
		const existing = frameStateByTabId.get(tabId)
		if (existing) {
			return existing
		}

		const created = createEmptyFrameState()
		frameStateByTabId.set(tabId, created)
		return created
	}

	function emitStatus(target: CdpSourceTarget | null, reason: string | null): void {
		events.onStatus({
			attached: Boolean(target),
			target: target
				? {
						title: target.title,
						url: target.url,
						type: target.type ?? 'page',
						parentId: target.parentId ?? null,
					}
				: null,
			reason,
		})
	}

	function emitTargetChanged(session: ExtensionSession): void {
		const target = getSelectedTarget(session)
		if (!target) {
			return
		}
		const state = getOrCreateFrameState(session.tabId)
		if (state.selectedAttachedAt == null) {
			state.selectedAttachedAt = Date.now()
		}
		emitStatus(target, null)
		messaging.send({
			type: 'target_info',
			targetId: target.id,
			title: target.title,
			url: target.url,
			attachedAt: state.selectedAttachedAt,
		})
		events.onTargetChanged?.(session.handle, target)
	}

	function getSelectedTarget(session: ExtensionSession): CdpSourceTarget | null {
		const state = frameStateByTabId.get(session.tabId)
		if (!state?.selectedFrameId) {
			return buildPageTarget(session, { attached: true })
		}

		const frame = state.frames.get(state.selectedFrameId)
		if (!frame) {
			return buildPageTarget(session, { attached: true })
		}

		return frameToTarget(session.tabId, frame, { attached: true, faviconUrl: session.faviconUrl, topFrameId: state.topFrameId })
	}

	function selectTarget(session: ExtensionSession, frameId: string | null): void {
		const state = getOrCreateFrameState(session.tabId)
		if (frameId && !state.frames.has(frameId)) {
			throw new Error(`Frame not found: ${frameId}`)
		}
		state.selectedFrameId = frameId
		state.selectedAttachedAt = Date.now()
		emitTargetChanged(session)
	}

	function selectTargetSafely(session: ExtensionSession, frameId: string | null, label: string): void {
		try {
			selectTarget(session, frameId)
		} catch (error) {
			console.warn(`[ExtensionSource] Failed to select ${label}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	async function refreshFrameTree(session: ExtensionSession): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		const frameTree = (await session.handle.sendAndWait('Page.getFrameTree')) as { frameTree?: CdpFrameTreeNode }
		state.frames.clear()
		collectFrameTree(frameTree.frameTree, state)
		await Promise.all([...state.executionContexts.keys()].map((frameId) => refreshFrameTitle(session, frameId)))
	}

	function removeFrame(tabId: number, frameId: string): void {
		const state = getOrCreateFrameState(tabId)
		const childIds = [...state.frames.values()].filter((frame) => frame.parentFrameId === frameId).map((frame) => frame.frameId)
		for (const childId of childIds) {
			removeFrame(tabId, childId)
		}
		state.frames.delete(frameId)
		state.executionContexts.delete(frameId)
		state.pendingTitleLoads.delete(frameId)
	}

	/**
	 * Frame tree metadata does not include the iframe document title, so we resolve it from the
	 * frame's default execution context and cache it alongside the rest of the frame state.
	 */
	async function refreshFrameTitle(session: ExtensionSession, frameId: string, contextId?: number): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		if (frameId === state.topFrameId || state.pendingTitleLoads.has(frameId)) {
			return
		}

		const executionContextId = contextId ?? state.executionContexts.get(frameId)
		if (executionContextId == null) {
			return
		}

		const frame = state.frames.get(frameId)
		if (!frame) {
			return
		}

		state.pendingTitleLoads.add(frameId)
		try {
			const evaluated = (await session.handle.sendAndWait('Runtime.evaluate', {
				expression: 'document.title',
				contextId: executionContextId,
				returnByValue: true,
				silent: true,
			})) as { result?: { value?: unknown } }

			const title = typeof evaluated.result?.value === 'string' ? evaluated.result.value.trim() : ''
			const latestFrame = state.frames.get(frameId)
			if (!latestFrame) {
				return
			}

			latestFrame.title = title || null
			if (state.selectedFrameId === frameId) {
				emitTargetChanged(session)
			}
		} catch {
			// Ignore transient frame-title lookup failures during navigation/bootstrap.
		} finally {
			state.pendingTitleLoads.delete(frameId)
		}
	}

	function createDelegatingSession(config: {
		getTargetContext: () => CdpTargetContext
		mapParams?: (method: string, params?: Record<string, unknown>) => Record<string, unknown> | undefined
	}): CdpSessionHandle {
		return {
			isAttached: () => currentSession?.handle.isAttached() ?? false,
			sendAndWait: async (method, params, options) => {
				const session = getCurrentExtensionSession()
				const nextParams = config.mapParams ? config.mapParams(method, params) : params
				return session.handle.sendAndWait(method, nextParams, options)
			},
			onEvent: (method, handler) => {
				if (!currentSession) {
					return () => {}
				}
				return currentSession.handle.onEvent(method, handler)
			},
			getTargetContext: config.getTargetContext,
		}
	}
}

/**
 * Convert TabInfo to CdpSourceTarget.
 */
const tabToTarget = (tab: TabInfo): CdpSourceTarget => ({
	id: formatPageTargetId(tab.tabId),
	title: tab.title,
	url: tab.url,
	type: 'page',
	faviconUrl: tab.faviconUrl,
	attached: tab.attached,
})

type ExtensionFrameState = {
	topFrameId: string | null
	selectedFrameId: string | null
	selectedAttachedAt: number | null
	frames: Map<string, ExtensionFrame>
	executionContexts: Map<string, number>
	pendingTitleLoads: Set<string>
}

const createEmptyFrameState = (): ExtensionFrameState => ({
	topFrameId: null,
	selectedFrameId: null,
	selectedAttachedAt: null,
	frames: new Map(),
	executionContexts: new Map(),
	pendingTitleLoads: new Set(),
})

type ExtensionFrame = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
}

type CdpFrameTreeNode = {
	frame?: {
		id?: string
		parentId?: string
		url?: string
		name?: string
	}
	childFrames?: CdpFrameTreeNode[]
}

const createNotAttachedError = (): Error => {
	const error = new Error('No tab attached via extension')
	;(error as Error & { code?: string }).code = 'cdp_not_attached'
	return error
}

const formatPageTargetId = (tabId: number): string => `tab:${tabId}`

const formatFrameTargetId = (tabId: number, frameId: string): string => `frame:${tabId}:${frameId}`

const parseExtensionTargetId = (targetId: string): { tabId: number; frameId: string | null } => {
	if (targetId.startsWith('tab:')) {
		const tabId = Number.parseInt(targetId.slice(4), 10)
		if (Number.isFinite(tabId)) {
			return { tabId, frameId: null }
		}
	}

	if (targetId.startsWith('frame:')) {
		const [, tabIdRaw, ...frameIdParts] = targetId.split(':')
		const tabId = Number.parseInt(tabIdRaw ?? '', 10)
		const frameId = frameIdParts.join(':')
		if (Number.isFinite(tabId) && frameId) {
			return { tabId, frameId }
		}
	}

	const legacyTabId = Number.parseInt(targetId, 10)
	if (Number.isFinite(legacyTabId)) {
		return { tabId: legacyTabId, frameId: null }
	}

	throw new Error(`Invalid extension target id: ${targetId}`)
}

const buildPageTarget = (session: ExtensionSession, options: { attached: boolean }): CdpSourceTarget => ({
	id: formatPageTargetId(session.tabId),
	title: session.title,
	url: session.url,
	type: 'page',
	parentId: null,
	faviconUrl: session.faviconUrl,
	attached: options.attached,
})

const frameToTarget = (
	tabId: number,
	frame: ExtensionFrame,
	options: { attached: boolean; faviconUrl?: string; topFrameId: string | null },
): CdpSourceTarget => ({
	id: formatFrameTargetId(tabId, frame.frameId),
	title: frame.title ?? frame.url ?? `iframe ${frame.frameId}`,
	url: frame.url,
	type: 'iframe',
	parentId:
		frame.parentFrameId && frame.parentFrameId !== options.topFrameId
			? formatFrameTargetId(tabId, frame.parentFrameId)
			: formatPageTargetId(tabId),
	faviconUrl: options.faviconUrl,
	attached: options.attached,
})

const buildFrameTargets = (state: ExtensionFrameState, tabId: number, selectedFrameId: string | null, faviconUrl?: string): CdpSourceTarget[] =>
	[...state.frames.values()]
		.filter((frame) => frame.frameId !== state.topFrameId)
		.map((frame) => frameToTarget(tabId, frame, { attached: frame.frameId === selectedFrameId, faviconUrl, topFrameId: state.topFrameId }))

const collectFrameTree = (node: CdpFrameTreeNode | undefined, state: ExtensionFrameState): void => {
	if (!node?.frame?.id) {
		return
	}

	const frameId = node.frame.id
	state.frames.set(frameId, {
		frameId,
		parentFrameId: node.frame.parentId ?? null,
		url: node.frame.url ?? '',
		title: node.frame.name ?? null,
	})
	if (!node.frame.parentId) {
		state.topFrameId = frameId
	}

	for (const child of node.childFrames ?? []) {
		collectFrameTree(child, state)
	}
}

const parseFrame = (params: unknown): ExtensionFrame | null => {
	const record = params as { frame?: { id?: string; parentId?: string | null; url?: string; name?: string } }
	const frameId = record.frame?.id
	const url = record.frame?.url
	if (!frameId || !url || typeof url !== 'string' || url.trim() === '') {
		return null
	}
	return {
		frameId,
		parentFrameId: record.frame?.parentId ?? null,
		url,
		title: record.frame?.name ?? null,
	}
}

const parseExecutionContext = (params: unknown): { id: number; frameId: string | null; isDefault: boolean } | null => {
	const record = params as {
		context?: {
			id?: number
			auxData?: { frameId?: string; isDefault?: boolean }
		}
	}
	if (record.context?.id == null) {
		return null
	}

	return {
		id: record.context.id,
		frameId: record.context.auxData?.frameId ?? null,
		isDefault: record.context.auxData?.isDefault === true,
	}
}

/**
 * Convert Runtime.consoleAPICalled event to LogEvent.
 */
const toConsoleEvent = (
	params: unknown,
	session: ExtensionSession,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		type?: LogLevel | string
		args?: Array<{ type: string; value?: unknown; description?: string }>
		timestamp?: number
		stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
	}

	const args = record.args?.map((a) => a.value) ?? []
	const text = formatArgs(record.args ?? [])

	const frame = selectBestFrame(record.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		source: 'console',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

/**
 * Convert Runtime.exceptionThrown event to LogEvent.
 */
const toExceptionEvent = (
	params: unknown,
	session: ExtensionSession,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		timestamp?: number
		exceptionDetails?: {
			text?: string
			exception?: { description?: string; value?: unknown }
			stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
		}
	}

	const details = record.exceptionDetails
	const text = details?.exception?.description ?? details?.text ?? 'Exception'
	const args = details?.exception ? [details.exception.value ?? details.exception.description] : []

	const frame = selectBestFrame(details?.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: 'exception',
		text,
		args,
		source: 'exception',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

/**
 * Format console args for display.
 */
const formatArgs = (args: Array<{ type: string; value?: unknown; description?: string }>): string => {
	if (args.length === 0) {
		return ''
	}

	return args
		.map((arg) => {
			if (arg.value !== undefined) {
				return typeof arg.value === 'string' ? arg.value : previewStringify(arg.value)
			}
			return arg.description ?? `[${arg.type}]`
		})
		.join(' ')
}

/**
 * Normalize console log type to LogLevel.
 */
const normalizeLevel = (type: LogLevel | string): LogEvent['level'] => {
	switch (type) {
		case 'log':
		case 'info':
		case 'debug':
		case 'dir':
		case 'dirxml':
		case 'table':
		case 'trace':
		case 'count':
		case 'timeEnd':
		case 'timeLog':
			return type === 'debug' ? 'debug' : type === 'info' ? 'info' : 'log'
		case 'warn':
		case 'warning':
			return 'warning'
		case 'error':
		case 'assert':
		case 'exception':
			return type === 'exception' ? 'exception' : 'error'
		default:
			return 'log'
	}
}

type CallFrame = { url: string; lineNumber: number; columnNumber: number }

/**
 * Select the best frame from the stack trace (first non-ignored frame).
 */
const selectBestFrame = (frames: CallFrame[] | undefined, ignoreMatcher: ((url: string) => boolean) | null | undefined): CallFrame | null => {
	if (!frames || frames.length === 0) {
		return null
	}

	if (!ignoreMatcher) {
		return frames[0] ?? null
	}

	for (const frame of frames) {
		if (frame.url && !ignoreMatcher(frame.url)) {
			return frame
		}
	}

	// Fall back to first frame if all are ignored
	return frames[0] ?? null
}

/**
 * Apply strip prefixes to a file URL.
 */
const applyStripPrefixes = (file: string | null, prefixes: string[] | undefined): string | null => {
	if (!file || !prefixes || prefixes.length === 0) {
		return file
	}

	for (const prefix of prefixes) {
		if (file.startsWith(prefix)) {
			return file.slice(prefix.length)
		}
	}

	return file
}
