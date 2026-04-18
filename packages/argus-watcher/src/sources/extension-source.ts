import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargets,
	buildPageTarget,
	createEmptyFrameState,
	createNotAttachedError,
	isSelectedTargetReady,
	parseExtensionTargetId,
	resolveSelectedFrameCommandState,
	type ExtensionFrameState,
} from './extension-frame-state.js'
import { createDelegatingSession, type DelegatingSessionController } from './extension-delegating-session.js'
import { registerExtensionSessionEventHandlers } from './extension-session-events.js'
import {
	getSelectedExtensionTarget,
	reconcileExtensionTargetSelection,
	refreshExtensionFrameTitle,
	refreshExtensionFrameTree,
	removeExtensionFrame,
	seedExtensionFrameState,
	setRequestedTargetSelection,
} from './extension-frame-runtime.js'

export type ExtensionSourceOptions = CdpSourceBaseOptions

const TARGET_RECOVERY_INTERVAL_MS = 500
const TARGET_RECOVERY_TIMEOUT_MS = 30_000
const FRAME_COMMAND_READY_TIMEOUT_MS = 3_000
const FRAME_COMMAND_READY_POLL_MS = 100
type TargetRecovery = { timer: ReturnType<typeof setInterval>; deadline: number }

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
	const targetRecoveryByTabId = new Map<number, TargetRecovery>()
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
			clearTargetRecovery(tabId)
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
		prepareCommand: async ({ method, params, targetContext }) => {
			if (targetContext.kind !== 'frame') {
				return undefined
			}

			const readyTargetContext = await waitForSelectedFrameCommandTarget()
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
		clearAllTargetRecovery()
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
		const session = requireOwnedSession(target.tabId)
		requestTargetSelection(session, target.frameId)
	}

	const detachTarget = (targetId: string): void => {
		const target = parseExtensionTargetId(targetId)
		const session = requireOwnedSession(target.tabId)
		sessionManager.detachTab(session.tabId)
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
		listTabs: async (filter) => {
			return await sessionManager.listTabs(filter)
		},
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

	function requireOwnedSession(tabId: number): ExtensionSession {
		const session = currentSession
		if (!session) {
			throw createNotAttachedError()
		}
		if (session.tabId !== tabId) {
			throw new Error(`Watcher ${hostInfo.watcherId} is pinned to tab ${session.tabId}, not tab ${tabId}`)
		}
		return session
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

	function clearAllTargetRecovery(): void {
		for (const tabId of targetRecoveryByTabId.keys()) {
			clearTargetRecovery(tabId)
		}
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
		syncTargetRecovery(session, state)
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

	function syncTargetRecovery(session: ExtensionSession, state: ExtensionFrameState): void {
		if (!needsTargetRecovery(state)) {
			clearTargetRecovery(session.tabId)
			return
		}

		if (targetRecoveryByTabId.has(session.tabId)) {
			return
		}

		const timer = setInterval(() => {
			void retryTargetRecovery(session.tabId)
		}, TARGET_RECOVERY_INTERVAL_MS)

		targetRecoveryByTabId.set(session.tabId, {
			timer,
			deadline: Date.now() + TARGET_RECOVERY_TIMEOUT_MS,
		})
	}

	async function kickTargetRecovery(session: ExtensionSession): Promise<void> {
		const state = getOrCreateFrameState(session.tabId)
		if (!needsTargetRecovery(state)) {
			return
		}

		syncTargetRecovery(session, state)
		await retryTargetRecovery(session.tabId)
	}

	function clearTargetRecovery(tabId: number): void {
		const recovery = targetRecoveryByTabId.get(tabId)
		if (!recovery) {
			return
		}

		clearInterval(recovery.timer)
		targetRecoveryByTabId.delete(tabId)
	}

	async function retryTargetRecovery(tabId: number): Promise<void> {
		const recovery = targetRecoveryByTabId.get(tabId)
		const session = currentSession
		if (!recovery || !session || session.tabId !== tabId) {
			clearTargetRecovery(tabId)
			return
		}

		if (hasTargetRecoveryExpired(recovery)) {
			clearTargetRecovery(tabId)
			return
		}

		const state = getOrCreateFrameState(tabId)
		if (!needsTargetRecovery(state)) {
			clearTargetRecovery(tabId)
			return
		}

		try {
			await refreshFrameTree(session)
		} catch {
			// Best-effort; Chrome can reject frame-tree reads transiently during reload.
		}

		reconcileTargetSelection(session)
		if (!needsTargetRecovery(getOrCreateFrameState(tabId))) {
			clearTargetRecovery(tabId)
		}
	}

	function buildFrameTargetContext(state: ExtensionFrameState, frameId: string): Extract<CdpTargetContext, { kind: 'frame' }> {
		return {
			kind: 'frame',
			frameId,
			executionContextId: state.executionContexts.get(frameId) ?? null,
			sessionId: state.frames.get(frameId)?.sessionId ?? null,
		}
	}

	function isTargetReady(tabId: number): boolean {
		return isSelectedTargetReady(getOrCreateFrameState(tabId))
	}

	async function waitForSelectedFrameCommandTarget(): Promise<Extract<CdpTargetContext, { kind: 'frame' }>> {
		const session = getCurrentExtensionSession()
		const tabId = session.tabId
		const immediate = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
		if (immediate.kind === 'frame') {
			return buildFrameTargetContext(getOrCreateFrameState(tabId), immediate.frameId)
		}

		await kickTargetRecovery(session)

		const deadline = Date.now() + FRAME_COMMAND_READY_TIMEOUT_MS
		while (Date.now() < deadline) {
			await delay(FRAME_COMMAND_READY_POLL_MS)

			const current = currentSession
			if (!current || current.tabId !== tabId) {
				throw createNotAttachedError()
			}

			const commandState = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
			if (commandState.kind === 'frame') {
				return buildFrameTargetContext(getOrCreateFrameState(tabId), commandState.frameId)
			}
		}

		throw buildSelectedFrameNotReadyError(tabId)
	}
}

function needsTargetRecovery(state: ExtensionFrameState): boolean {
	return resolveSelectedFrameCommandState(state).kind === 'pending'
}

function hasTargetRecoveryExpired(recovery: TargetRecovery): boolean {
	return Date.now() >= recovery.deadline
}

function buildSelectedFrameNotReadyError(tabId: number): Error {
	const error = new Error(
		`Selected iframe target on tab ${tabId} is not executable yet after reload. Try again in a few seconds or reattach the watcher if the problem persists.`,
	)
	;(error as Error & { code?: string }).code = 'extension_frame_not_ready'
	return error
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
