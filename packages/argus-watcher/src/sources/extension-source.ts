import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { ExtensionToTabHost, TabHostToExtension } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargetContext,
	buildFrameTargets,
	buildPageTarget,
	createEmptyFrameState,
	createNotAttachedError,
	isSelectedTargetReady,
	parseExtensionTargetId,
	type ExtensionFrameState,
} from './extension-frame-state.js'
import { createDelegatingSession, type DelegatingSessionController } from './extension-delegating-session.js'
import { registerExtensionSessionEventHandlers } from './extension-session-events.js'
import { createControlExtensionSource } from './extension-control-source.js'
import { createTargetRecovery } from './extension-target-recovery.js'
import {
	getSelectedExtensionTarget,
	reconcileExtensionTargetSelection,
	refreshExtensionFrameTitle,
	refreshExtensionFrameTree,
	removeExtensionFrame,
	seedExtensionFrameState,
	setRequestedTargetSelection,
} from './extension-frame-runtime.js'

export type ExtensionSourceOptions = CdpSourceBaseOptions & {
	role?: 'tab' | 'control'
}

/**
 * Create an extension source that connects to Chrome via Native Messaging.
 * Returns a handle that can be used to control the source and access CDP session.
 */
export const createExtensionSource = (options: ExtensionSourceOptions): CdpSourceHandle => {
	if (options.role === 'control') {
		return createControlExtensionSource(options)
	}

	const { events, ignoreMatcher, stripUrlPrefixes, watcherId, watcherHost, watcherPort } = options

	const messaging = createNativeMessaging<ExtensionToTabHost, TabHostToExtension>()
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

	const targetRecovery = createTargetRecovery({
		getCurrentSession: () => currentSession,
		getOrCreateFrameState,
		refreshFrameTree,
		reconcileTargetSelection,
	})

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
			targetRecovery.clear(tabId)
			frameStateByTabId.delete(tabId)
			emitStatus(null, reason)
			events.onDetach?.(reason)
		},

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
		prepareCommand: async ({ method, params, targetContext }) => {
			if (targetContext.kind !== 'frame') {
				return undefined
			}

			const readyTargetContext = await targetRecovery.waitForSelectedFrameCommandTarget()
			if (method !== 'Runtime.evaluate' || params?.contextId != null || readyTargetContext.sessionId) {
				return { targetContext: readyTargetContext }
			}

			return {
				targetContext: readyTargetContext,
				params: {
					...(params ?? {}),
					contextId: readyTargetContext.executionContextId,
				},
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
	messaging.send({ type: 'host_ready' })
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
		targetRecovery.clearAll()
		disposeDelegatingSessions()
		messaging.stop()
	}

	const listTargets = async (): Promise<CdpSourceTarget[]> => {
		const session = currentSession
		if (!session) {
			return []
		}

		const state = frameStateByTabId.get(session.tabId)
		if (!state || state.frames.size === 0) {
			return [buildPageTarget(session, { attached: true })]
		}

		const activeFrameId = state.activeFrameId
		const targets: CdpSourceTarget[] = [buildPageTarget(session, { attached: activeFrameId == null })]
		for (const frame of buildFrameTargets(state, session.tabId, activeFrameId, session.faviconUrl)) {
			targets.push(frame)
		}
		return targets
	}

	const attachTarget = (targetId: string): void => {
		const target = parseExtensionTargetId(targetId)
		const session = currentSession
		if (!session) {
			if (target.frameId) {
				throw new Error(`Cannot attach iframe ${target.frameId} before tab ${target.tabId} is attached`)
			}
			throw new Error(`Watcher ${hostInfo.watcherId} is a tab watcher. Use extension-control to attach tab ${target.tabId}.`)
		}
		if (session.tabId !== target.tabId) {
			throw new Error(`Watcher ${hostInfo.watcherId} is pinned to tab ${session.tabId}, not tab ${target.tabId}`)
		}
		requestTargetSelection(session, target.frameId)
	}

	const detachTarget = (targetId: string): void => {
		const target = parseExtensionTargetId(targetId)
		const session = currentSession
		if (!session || session.tabId === target.tabId) {
			sessionManager.detachTab(target.tabId)
			return
		}
		throw new Error(`Watcher ${hostInfo.watcherId} is pinned to tab ${session.tabId}, not tab ${target.tabId}`)
	}

	return {
		session: proxySession,
		pageSession,
		readBrowserCookies: async ({ domain, url }) => {
			const session = getCurrentExtensionSession()
			return await sessionManager.getCookies(session.tabId, {
				domain: domain ?? undefined,
				url: url ?? undefined,
			})
		},
		getNetFilterContext: () => {
			const session = currentSession
			if (!session) {
				return null
			}

			const state = frameStateByTabId.get(session.tabId)
			const selectedTarget = getSelectedTarget(session)
			return {
				sourceMode: 'extension',
				selectedFrameId: state?.activeFrameId ?? null,
				topFrameId: state?.topFrameId ?? session.topFrameId,
				selectedTargetUrl: selectedTarget?.url ?? session.url,
				pageUrl: session.url,
			}
		},
		getFrameSessionId: (frameId) => {
			const session = currentSession
			if (!session) {
				return null
			}

			const state = frameStateByTabId.get(session.tabId)
			return state?.frames.get(frameId)?.sessionId ?? null
		},
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

			/**
			 * Selection can land before bootstrap finishes (for example when the extension restores the
			 * last iframe immediately after reconnect). Respect the current selected target here so the
			 * watcher status and page indicator do not get overwritten with the parent page afterward.
			 */
			const target = getSelectedTarget(session) ?? buildPageTarget(session, { attached: true })
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

		return buildFrameTargetContext(state, state.activeFrameId)
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
		return seedExtensionFrameState(session, state)
	}

	function emitStatus(target: CdpSourceTarget | null, reason: string | null): void {
		const session = currentSession
		const targetReady = target == null ? null : session ? isTargetReady(session.tabId) : true
		events.onStatus({
			attached: Boolean(target),
			targetReady,
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
		const targetReady = isTargetReady(session.tabId)
		emitStatus(target, null)
		messaging.send({
			type: 'target_info',
			targetId: target.id,
			title: target.title,
			url: target.url,
			attachedAt: state.activeAttachedAt,
			targetReady,
		})
		events.onTargetChanged?.(session.handle, target)
	}

	function getSelectedTarget(session: ExtensionSession): CdpSourceTarget | null {
		return getSelectedExtensionTarget(session, frameStateByTabId.get(session.tabId))
	}

	function requestTargetSelection(session: ExtensionSession, frameId: string | null): void {
		const state = getOrCreateFrameState(session.tabId)
		setRequestedTargetSelection(state, frameId)
		reconcileTargetSelection(session)
	}

	/**
	 * Popup selection can arrive before the iframe's session is fully bootstrapped.
	 * Keep the request pending until the frame is discovered instead of routing commands
	 * to the parent page and pretending the switch already happened.
	 */
	function reconcileTargetSelection(session: ExtensionSession): boolean {
		const state = getOrCreateFrameState(session.tabId)
		const changed = reconcileExtensionTargetSelection(session, state, () => {
			emitTargetChanged(session)
		})
		targetRecovery.sync(session, state)
		return changed
	}

	async function refreshFrameTree(session: ExtensionSession): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		await refreshExtensionFrameTree(session, state, (frameId) => refreshFrameTitle(session, frameId))
	}

	function removeFrame(tabId: number, frameId: string): void {
		const state = getOrCreateFrameState(tabId)
		removeExtensionFrame(state, frameId)
	}

	/**
	 * Frame tree metadata does not include the iframe document title, so we resolve it from the
	 * frame's default execution context and cache it alongside the rest of the frame state.
	 */
	async function refreshFrameTitle(session: ExtensionSession, frameId: string, contextId?: number): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		await refreshExtensionFrameTitle(
			session,
			state,
			frameId,
			() => {
				emitTargetChanged(session)
			},
			contextId,
		)
	}

	function isTargetReady(tabId: number): boolean {
		return isSelectedTargetReady(getOrCreateFrameState(tabId))
	}
}
