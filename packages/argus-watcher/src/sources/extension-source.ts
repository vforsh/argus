/**
 * Extension source for CDP access via Chrome extension Native Messaging.
 * Wraps SessionManager and provides a unified source interface.
 */

import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { TabInfo } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpSessionHandle, CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargets,
	buildPageTarget,
	collectFrameTree,
	createEmptyFrameState,
	createNotAttachedError,
	frameToTarget,
	formatPageTargetId,
	parseExecutionContext,
	parseExtensionTargetId,
	parseFrame,
	resolveRequestedFrameId,
	type CdpFrameTreeNode,
	type ExtensionFrameState,
} from './extension-frame-state.js'
import { toConsoleEvent, toExceptionEvent } from './extension-log-events.js'

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
	const delegatingSessions = new Set<DelegatingSessionController>()
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
			rebindDelegatingSessions()
			seedFrameState(session)
			void bootstrapAttachedSession(session)
		},

		onDetach: (tabId: number, reason: string) => {
			console.error(`[ExtensionSource] Tab detached: ${tabId} - ${reason}`)

			if (currentSession?.tabId === tabId) {
				currentSession = null
			}
			rebindDelegatingSessions()
			frameStateByTabId.delete(tabId)

			emitStatus(null, reason)

			events.onDetach?.(reason)
		},

		onTabsUpdated: () => {
			// Tabs list updated - no action needed
		},

		onTargetSelected: (tabId, frameId) => {
			const session = currentSession
			if (!session || session.tabId !== tabId) {
				getOrCreateFrameState(tabId).requestedFrameId = frameId
				return
			}
			requestTargetSelection(session, frameId)
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
		disposeDelegatingSessions()
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

			const activeFrameId = state.activeFrameId
			const targets: CdpSourceTarget[] = [buildPageTarget(session, { attached: activeFrameId == null })]
			for (const frame of buildFrameTargets(state, tab.tabId, activeFrameId, tab.faviconUrl)) {
				targets.push(frame)
			}
			return targets
		})
	}

	const attachTarget = (targetId: string): void => {
		const target = parseExtensionTargetId(targetId)
		const session = currentSession
		if (!session || session.tabId !== target.tabId) {
			getOrCreateFrameState(target.tabId).requestedFrameId = target.frameId
			sessionManager.attachTab(target.tabId)
			return
		}

		requestTargetSelection(session, target.frameId)
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

	function rebindDelegatingSessions(): void {
		for (const controller of delegatingSessions) {
			controller.rebind()
		}
	}

	function disposeDelegatingSessions(): void {
		for (const controller of delegatingSessions) {
			controller.dispose()
		}
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
			reconcileTargetSelection(session)
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

	function registerSessionEventHandlers(session: ExtensionSession): void {
		session.handle.onEvent('Runtime.executionContextCreated', (params, meta) => {
			const context = parseExecutionContext(params)
			if (!context?.isDefault || !context.frameId) {
				return
			}
			const state = getOrCreateFrameState(session.tabId)
			state.executionContexts.set(context.frameId, context.id)
			const frame = state.frames.get(context.frameId)
			if (frame) {
				frame.sessionId = meta.sessionId ?? null
			}
			void refreshFrameTitle(session, context.frameId, context.id)
			reconcileTargetSelection(session)
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

		session.handle.onEvent('Page.frameNavigated', (params, meta) => {
			const frame = parseFrame(params)
			if (!frame) {
				return
			}

			const state = getOrCreateFrameState(session.tabId)
			state.frames.set(frame.frameId, frame)
			frame.sessionId = meta.sessionId ?? null
			if (!frame.parentFrameId) {
				if (!meta.sessionId) {
					state.topFrameId = frame.frameId
					session.url = frame.url
				} else if (state.topFrameId == null) {
					state.topFrameId = frame.parentFrameId
				}
			} else if (state.executionContexts.has(frame.frameId)) {
				void refreshFrameTitle(session, frame.frameId)
			}
			currentSession = session

			if (!frame.parentFrameId && !meta.sessionId) {
				events.onPageNavigation?.({ url: frame.url, title: session.title ?? null })
			}

			if (reconcileTargetSelection(session)) {
				return
			}

			if ((!frame.parentFrameId && state.activeFrameId == null) || state.activeFrameId === frame.frameId) {
				emitTargetChanged(session)
			}
		})

		session.handle.onEvent('Page.frameAttached', (params, meta) => {
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
				sessionId: meta.sessionId ?? null,
			})
			reconcileTargetSelection(session)
		})

		session.handle.onEvent('Page.frameDetached', (params) => {
			const record = params as { frameId?: string }
			if (!record.frameId) {
				return
			}
			removeFrame(session.tabId, record.frameId)
			reconcileTargetSelection(session)
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
		if (!state?.activeFrameId) {
			return { kind: 'page' }
		}

		return {
			kind: 'frame',
			frameId: state.activeFrameId,
			executionContextId: state.executionContexts.get(state.activeFrameId) ?? null,
			sessionId: state.frames.get(state.activeFrameId)?.sessionId ?? null,
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

	function seedFrameState(session: ExtensionSession): ExtensionFrameState {
		const state = getOrCreateFrameState(session.tabId)
		if (state.frames.size > 0 || session.frames.length === 0) {
			return state
		}

		state.topFrameId = session.topFrameId
		for (const frame of session.frames) {
			state.frames.set(frame.frameId, {
				frameId: frame.frameId,
				parentFrameId: frame.parentFrameId,
				url: frame.url,
				title: frame.title,
				sessionId: frame.sessionId,
			})
		}
		return state
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
		if (state.activeAttachedAt == null) {
			state.activeAttachedAt = Date.now()
		}
		emitStatus(target, null)
		messaging.send({
			type: 'target_info',
			targetId: target.id,
			title: target.title,
			url: target.url,
			attachedAt: state.activeAttachedAt,
		})
		events.onTargetChanged?.(session.handle, target)
	}

	function getSelectedTarget(session: ExtensionSession): CdpSourceTarget | null {
		const state = frameStateByTabId.get(session.tabId)
		if (!state?.activeFrameId) {
			return buildPageTarget(session, { attached: true })
		}

		const frame = state.frames.get(state.activeFrameId)
		if (!frame) {
			return buildPageTarget(session, { attached: true })
		}

		return frameToTarget(session.tabId, frame, { attached: true, faviconUrl: session.faviconUrl, topFrameId: state.topFrameId })
	}

	function requestTargetSelection(session: ExtensionSession, frameId: string | null): void {
		const state = getOrCreateFrameState(session.tabId)
		state.requestedFrameId = frameId
		reconcileTargetSelection(session)
	}

	/**
	 * Popup selection can arrive before the iframe's session is fully bootstrapped.
	 * Keep the request pending until the frame is discovered instead of routing commands
	 * to the parent page and pretending the switch already happened.
	 */
	function reconcileTargetSelection(session: ExtensionSession): boolean {
		const state = getOrCreateFrameState(session.tabId)
		const nextActiveFrameId = resolveRequestedFrameId(state, state.requestedFrameId)

		if (state.requestedFrameId == null) {
			if (state.activeFrameId == null) {
				if (state.activeAttachedAt == null) {
					state.activeAttachedAt = Date.now()
					emitTargetChanged(session)
					return true
				}
				return false
			}

			state.activeFrameId = null
			state.activeAttachedAt = Date.now()
			emitTargetChanged(session)
			return true
		}

		if (nextActiveFrameId == null || state.activeFrameId === nextActiveFrameId) {
			return false
		}

		state.activeFrameId = nextActiveFrameId
		state.activeAttachedAt = Date.now()
		emitTargetChanged(session)
		return true
	}

	async function refreshFrameTree(session: ExtensionSession): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		const frameTree = (await session.handle.sendAndWait('Page.getFrameTree')) as { frameTree?: CdpFrameTreeNode }
		collectFrameTree(frameTree.frameTree, state)
		await Promise.all([...state.executionContexts.keys()].map((frameId) => refreshFrameTitle(session, frameId)))
	}

	function removeFrame(tabId: number, frameId: string): void {
		const state = getOrCreateFrameState(tabId)
		const childIds = [...state.frames.values()].filter((frame) => frame.parentFrameId === frameId).map((frame) => frame.frameId)
		for (const childId of childIds) {
			removeFrame(tabId, childId)
		}
		if (state.requestedFrameId === frameId) {
			state.requestedFrameId = null
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
			const evaluated = (await session.handle.sendAndWait(
				'Runtime.evaluate',
				{
					expression: 'document.title',
					contextId: executionContextId,
					returnByValue: true,
					silent: true,
				},
				frame.sessionId ? { sessionId: frame.sessionId } : undefined,
			)) as { result?: { value?: unknown } }

			const title = typeof evaluated.result?.value === 'string' ? evaluated.result.value.trim() : ''
			const latestFrame = state.frames.get(frameId)
			if (!latestFrame) {
				return
			}

			latestFrame.title = title || null
			if (state.activeFrameId === frameId) {
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
		const subscriptions = new Set<DelegatingEventSubscription>()
		const rebindSubscriptions = (): void => {
			// Delegating sessions are created before a tab may be attached, so event listeners
			// must follow the active extension session instead of binding once and going stale.
			for (const subscription of subscriptions) {
				subscription.unbind()
				if (!currentSession) {
					continue
				}
				subscription.off = currentSession.handle.onEvent(subscription.method, subscription.handler)
			}
		}

		const disposeSubscriptions = (): void => {
			for (const subscription of subscriptions) {
				subscription.unbind()
			}
			subscriptions.clear()
		}

		const controller: DelegatingSessionController = {
			rebind: rebindSubscriptions,
			dispose: () => {
				disposeSubscriptions()
				delegatingSessions.delete(controller)
			},
		}

		delegatingSessions.add(controller)
		controller.rebind()

		return {
			isAttached: () => currentSession?.handle.isAttached() ?? false,
			sendAndWait: async (method, params, options) => {
				const session = getCurrentExtensionSession()
				const targetContext = config.getTargetContext()
				const nextParams = config.mapParams ? config.mapParams(method, params) : params
				const nextOptions =
					targetContext.kind === 'frame' && targetContext.sessionId ? { ...(options ?? {}), sessionId: targetContext.sessionId } : options
				return session.handle.sendAndWait(method, nextParams, nextOptions)
			},
			onEvent: (method, handler) => {
				const subscription = createDelegatingEventSubscription(method, handler)
				subscriptions.add(subscription)
				controller.rebind()

				return () => {
					subscription.unbind()
					subscriptions.delete(subscription)
				}
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

type DelegatingEventSubscription = {
	method: string
	handler: Parameters<CdpSessionHandle['onEvent']>[1]
	off: (() => void) | null
	unbind: () => void
}

type DelegatingSessionController = {
	rebind: () => void
	dispose: () => void
}

const createDelegatingEventSubscription = (method: string, handler: Parameters<CdpSessionHandle['onEvent']>[1]): DelegatingEventSubscription => ({
	method,
	handler,
	off: null,
	unbind() {
		this.off?.()
		this.off = null
	},
})
