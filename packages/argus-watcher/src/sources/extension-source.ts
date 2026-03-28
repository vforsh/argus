import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { TabInfo } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargets,
	buildPageTarget,
	collectFrameTree,
	createRequestedFrameHint,
	createEmptyFrameState,
	createNotAttachedError,
	frameToTarget,
	formatPageTargetId,
	parseExtensionTargetId,
	resolveRequestedTarget,
	type CdpFrameTreeNode,
	type ExtensionFrameState,
} from './extension-frame-state.js'
import { createDelegatingSession, type DelegatingSessionController } from './extension-delegating-session.js'
import { registerExtensionSessionEventHandlers } from './extension-session-events.js'

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

		onTabsUpdated: () => {},

		onTargetSelected: (tabId, frameId) => {
			const session = currentSession
			if (!session || session.tabId !== tabId) {
				const state = getOrCreateFrameState(tabId)
				setRequestedTargetSelection(state, frameId)
				return
			}
			requestTargetSelection(session, frameId)
		},
	})

	// Proxy session follows the currently selected page/frame target inside the attached tab.
	const { session: proxySession, controller: proxyController } = createDelegatingSession({
		getCurrentSession: () => currentSession,
		requireCurrentSession: getCurrentExtensionSession,
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
	delegatingSessions.add(proxyController)

	// Page session stays pinned to the top-level tab for page-scoped features like the indicator and inject-on-attach.
	const { session: pageSession, controller: pageController } = createDelegatingSession({
		getCurrentSession: () => currentSession,
		requireCurrentSession: getCurrentExtensionSession,
		getTargetContext: () => ({ kind: 'page' }),
	})
	delegatingSessions.add(pageController)

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
			const state = getOrCreateFrameState(target.tabId)
			setRequestedTargetSelection(state, target.frameId)
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
		delegatingSessions.clear()
	}

	async function bootstrapAttachedSession(session: ExtensionSession): Promise<void> {
		try {
			registerExtensionSessionEventHandlers({
				session,
				events,
				ignoreMatcher,
				stripUrlPrefixes,
				getOrCreateFrameState,
				reconcileTargetSelection,
				removeFrame,
				refreshFrameTitle,
				emitTargetChanged,
				setCurrentSession: (nextSession) => {
					currentSession = nextSession
				},
			})
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
		setRequestedTargetSelection(state, frameId)
		reconcileTargetSelection(session)
	}

	function setRequestedTargetSelection(state: ExtensionFrameState, frameId: string | null): void {
		const frame = frameId ? state.frames.get(frameId) : null
		state.requestedFrameId = frameId
		state.requestedFrameHint = createRequestedFrameHint(frame)
		state.requestedFrameDetached = false
	}

	/**
	 * Popup selection can arrive before the iframe's session is fully bootstrapped.
	 * Keep the request pending until the frame is discovered instead of routing commands
	 * to the parent page and pretending the switch already happened.
	 */
	function reconcileTargetSelection(session: ExtensionSession): boolean {
		const state = getOrCreateFrameState(session.tabId)
		const resolution = resolveRequestedTarget(state)

		if (resolution.kind === 'page') {
			state.requestedFrameDetached = false
			return activatePageTarget(session, state)
		}

		if (resolution.kind === 'pending') {
			return false
		}

		state.requestedFrameDetached = false
		if (state.activeFrameId === resolution.frameId) {
			return false
		}

		return activateFrameTarget(session, state, resolution.frameId)
	}

	function activatePageTarget(session: ExtensionSession, state: ExtensionFrameState): boolean {
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

	function activateFrameTarget(session: ExtensionSession, state: ExtensionFrameState, frameId: string): boolean {
		state.activeFrameId = frameId
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

		/**
		 * Keep the user's requested iframe selection across reload/navigation detaches.
		 * Frame ids are ephemeral, so the stored frame hint lets selection survive a fresh id after reload.
		 */
		if (state.activeFrameId === frameId) {
			state.requestedFrameDetached = state.requestedFrameId === frameId
			state.activeFrameId = null
			state.activeAttachedAt = null
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
