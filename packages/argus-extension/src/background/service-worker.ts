/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Owns one debugger manager plus one Native Messaging bridge session per attached tab.
 */

import { DebuggerManager } from './debugger-manager.js'
import { TabBridgeSession } from './tab-bridge-session.js'
import {
	type RememberedTargetSelection,
	type SelectionTarget,
	TargetSelectionHistoryStore,
	matchRememberedIframeTarget,
} from './target-selection-history.js'
import { TargetVisibilityHistoryStore, matchesHiddenTarget } from './target-visibility-history.js'
import { listBrowserTabs } from './tab-list.js'

const debuggerManager = new DebuggerManager()
const bridgeSessions = new Map<number, TabBridgeSession>()
const selectedFrameByTabId = new Map<number, string | null>()
// Re-try a remembered iframe while Chrome is still populating frame metadata for a fresh attach.
const pendingRememberedTargetByTabId = new Map<number, RememberedTargetSelection>()
const targetSelectionHistory = new TargetSelectionHistoryStore()
const targetVisibilityHistory = new TargetVisibilityHistoryStore()
const recentEvents: PopupEvent[] = []
const MAX_RECENT_EVENTS = 8
const REMEMBERED_TARGET_RETRY_EVENTS = new Set(['Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated'])

type PopupEvent = {
	ts: number
	level: 'info' | 'error'
	source: 'bridge' | 'debugger' | 'popup'
	message: string
}

type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
}

type PopupWatcherStatus = {
	tabId: number
	bridgeConnected: boolean
	nativeHostConnected: boolean
	watcherReady: boolean
	targetReady: boolean | null
	targetState: 'ready' | 'rebinding' | 'not-selected'
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	nativeHostPid: number | null
	lastMessageAt: number | null
	currentTarget: PopupCurrentTarget | null
}

type PopupCurrentTarget = {
	type: 'page' | 'iframe'
	title: string | null
	url: string | null
	targetId: string
	frameId: string | null
	attachedAt: number
	targetReady: boolean | null
}

type PopupStatusPayload = {
	bridgeConnected: boolean
	attachedTabs: Array<{
		tabId: number
		url: string
		title: string
	}>
	watchers: PopupWatcherStatus[]
	recentEvents: PopupEvent[]
}

type PopupTabWithTargets = Awaited<ReturnType<typeof getTabsForPopup>>[number] & {
	targets: PopupTarget[]
	hiddenTargets: PopupTarget[]
	selectedFrameId?: string | null
	watcher: PopupWatcherStatus | null
}

type PopupActionMessage = {
	action: string
	tabId?: number
	frameId?: string | null
}

type PopupResponse =
	| { success: true }
	| { success: true; tabs: PopupTabWithTargets[] }
	| { success: true; status: PopupStatusPayload }
	| { success: false; error: string }

let badgeSyncChain: Promise<void> = Promise.resolve()

function recordEvent(level: PopupEvent['level'], source: PopupEvent['source'], message: string): void {
	recentEvents.unshift({
		ts: Date.now(),
		level,
		source,
		message,
	})

	if (recentEvents.length > MAX_RECENT_EVENTS) {
		recentEvents.length = MAX_RECENT_EVENTS
	}
}

/**
 * Serialize badge writes and reconcile on popup reads so an external detach from Chrome's
 * debugger infobar cannot leave stale badge text behind.
 */
function syncActionBadge(): Promise<void> {
	badgeSyncChain = badgeSyncChain
		.catch(() => undefined)
		.then(async () => {
			const attachedCount = debuggerManager.listAttached().length
			await applyBadgeState(attachedCount)
		})
		.catch((error) => {
			console.error('[ServiceWorker] Failed to sync action badge:', error)
		})

	return badgeSyncChain
}

async function applyBadgeState(attachedCount: number): Promise<void> {
	const badgeText = attachedCount > 0 ? String(attachedCount) : ''
	const tabs = await chrome.tabs.query({})

	// Clear any tab-specific badge text Chrome may still be holding onto, then keep the default in sync.
	await Promise.all(
		tabs
			.filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
			.map((tab) => chrome.action.setBadgeText({ tabId: tab.id, text: badgeText })),
	)
	await chrome.action.setBadgeText({ text: badgeText })

	if (attachedCount > 0) {
		await chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' })
	}
}

debuggerManager.onDetach((tabId, reason) => {
	clearTabState(tabId)
	recordEvent('error', 'debugger', `Tab ${tabId} detached: ${reason}`)
	void syncActionBadge()
})

debuggerManager.onEvent((tabId, method) => {
	if (!shouldReplayRememberedTarget(tabId, method)) {
		return
	}

	void replayRememberedTargetSelection(tabId)
})

chrome.runtime.onMessage.addListener(
	(message: PopupActionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
		void handlePopupMessage(message, sendResponse)
		return true
	},
)

async function handlePopupMessage(message: PopupActionMessage, sendResponse: (response: unknown) => void): Promise<void> {
	pruneStaleBridgeSessions()
	const response = await buildPopupResponse(message)
	await syncActionBadge()
	sendResponse(response)
}

async function buildPopupResponse(message: PopupActionMessage): Promise<PopupResponse> {
	try {
		switch (message.action) {
			case 'getTargets':
				return { success: true, tabs: await getTabsWithTargets() }

			case 'attach': {
				const tabId = requireTabId(message)
				await attachBridgeSession(tabId)
				setSelectedFrame(tabId, null)
				await prepareRememberedTargetSelection(tabId)
				recordEvent('info', 'popup', `Attached tab ${tabId}`)
				return { success: true }
			}

			case 'detach': {
				const tabId = requireTabId(message)
				await detachTab(tabId)
				recordEvent('info', 'popup', `Detached tab ${tabId}`)
				return { success: true }
			}

			case 'focusTab': {
				const tabId = requireTabId(message)
				await focusTab(tabId)
				recordEvent('info', 'popup', `Focused tab ${tabId}`)
				return { success: true }
			}

			case 'selectTarget': {
				const tabId = requireTabId(message)
				const session = bridgeSessions.get(tabId)
				if (!session) {
					return { success: false, error: `No watcher bridge for tab ${tabId}` }
				}

				const frameId = message.frameId ?? null
				const target = getPopupTarget(tabId, frameId)
				if (!target) {
					return { success: false, error: `Unknown target for tab ${tabId}` }
				}

				session.selectTarget(frameId)
				clearPendingRememberedTarget(tabId)
				setSelectedFrame(tabId, frameId)
				await rememberTargetSelection(tabId, target)
				recordEvent('info', 'popup', `Selected ${frameId ? `iframe ${frameId}` : 'page'} on tab ${tabId}`)
				return { success: true }
			}

			case 'hideTarget': {
				const tabId = requireTabId(message)
				const target = getRequiredIframeTarget(tabId, message.frameId ?? null)
				await hideTarget(tabId, target)
				recordEvent('info', 'popup', `Hid iframe ${target.frameId} on tab ${tabId}`)
				return { success: true }
			}

			case 'showTarget': {
				const tabId = requireTabId(message)
				const target = getRequiredIframeTarget(tabId, message.frameId ?? null)
				await showTarget(tabId, target)
				recordEvent('info', 'popup', `Restored iframe ${target.frameId} on tab ${tabId}`)
				return { success: true }
			}

			case 'getStatus':
				return {
					success: true,
					status: buildPopupStatusPayload(),
				}

			default:
				return { success: false, error: `Unknown action: ${message.action}` }
		}
	} catch (err) {
		recordEvent('error', 'popup', err instanceof Error ? err.message : 'Unknown popup error')
		return {
			success: false,
			error: err instanceof Error ? err.message : 'Unknown error',
		}
	}
}

function requireTabId(message: PopupActionMessage): number {
	if (message.tabId !== undefined) {
		return message.tabId
	}

	throw new Error('No tabId provided')
}

async function attachBridgeSession(tabId: number): Promise<void> {
	const existing = bridgeSessions.get(tabId)
	if (existing) {
		await connectBridgeSession(tabId, existing)
		return
	}

	const session = new TabBridgeSession(tabId, debuggerManager, {
		onWatcherInfo: (info) => {
			recordEvent('info', 'bridge', `Watcher ready for tab ${tabId}: ${info.watcherId} (pid ${info.pid})`)
		},
		onTargetInfo: (info) => {
			syncSelectedFrameFromWatcher(info.targetId)
		},
		onDisconnect: () => {
			recordEvent('error', 'bridge', `Native host disconnected for tab ${tabId}`)
			void debuggerManager.detach(tabId).catch(() => {})
			clearTabState(tabId)
			void syncActionBadge()
		},
	})
	bridgeSessions.set(tabId, session)
	await connectBridgeSession(tabId, session)
}

async function detachTab(tabId: number): Promise<void> {
	const session = bridgeSessions.get(tabId)
	if (session) {
		await session.detach()
	} else {
		await debuggerManager.detach(tabId)
	}

	clearTabState(tabId)
}

/**
 * Activating the tab is not enough when it lives in a background window, so explicitly focus the host window too.
 */
async function focusTab(tabId: number): Promise<void> {
	const tab = await chrome.tabs.get(tabId)
	await chrome.tabs.update(tabId, { active: true })
	await chrome.windows.update(tab.windowId, { focused: true })
}

async function connectBridgeSession(tabId: number, session: TabBridgeSession): Promise<void> {
	try {
		await session.connectAndAttach()
	} catch (error) {
		destroyBridgeSession(tabId)
		throw error
	}
}

function clearTabState(tabId: number): void {
	selectedFrameByTabId.delete(tabId)
	clearPendingRememberedTarget(tabId)
	destroyBridgeSession(tabId)
}

/**
 * Chrome can drop the root debugger attachment from the infobar while the native host is still
 * alive long enough to keep reporting its last selected target. Trim those orphaned bridge
 * sessions before serving popup state so the badge and popup stay aligned with actual attachments.
 */
function pruneStaleBridgeSessions(): void {
	for (const [tabId, session] of bridgeSessions.entries()) {
		if (debuggerManager.isAttached(tabId)) {
			continue
		}

		if (!session.getTargetInfo()) {
			continue
		}

		clearTabState(tabId)
		recordEvent('error', 'bridge', `Pruned stale watcher state for tab ${tabId}`)
	}
}

function destroyBridgeSession(tabId: number): void {
	const session = bridgeSessions.get(tabId)
	if (!session) {
		return
	}

	bridgeSessions.delete(tabId)
	session.dispose()
}

function buildPopupStatusPayload(): PopupStatusPayload {
	return {
		bridgeConnected: [...bridgeSessions.values()].some((session) => session.isConnected()),
		attachedTabs: debuggerManager.listAttached().map((target) => ({
			tabId: target.tabId,
			url: target.url,
			title: target.title,
		})),
		watchers: getWatcherStatuses(),
		recentEvents,
	}
}

function getWatcherStatuses(): PopupWatcherStatus[] {
	return [...bridgeSessions.entries()]
		.map(([tabId, session]) => buildWatcherStatus(tabId, session))
		.filter((status): status is PopupWatcherStatus => status !== null)
}

function buildWatcherStatus(tabId: number, session: TabBridgeSession): PopupWatcherStatus | null {
	const watcherInfo = session.getWatcherInfo()
	const targetInfo = session.getTargetInfo()
	const parsedTarget = targetInfo ? parseWatcherTargetId(targetInfo.targetId) : null

	if (!watcherInfo && !targetInfo) {
		return createWatcherStatus(tabId, session, null, null)
	}

	return createWatcherStatus(
		tabId,
		session,
		watcherInfo ?? null,
		targetInfo && parsedTarget
			? {
					type: parsedTarget.frameId ? 'iframe' : 'page',
					title: targetInfo.title,
					url: targetInfo.url,
					targetId: targetInfo.targetId,
					frameId: parsedTarget.frameId,
					attachedAt: targetInfo.attachedAt,
					targetReady: targetInfo.targetReady,
				}
			: null,
	)
}

async function getTabsWithTargets(): Promise<PopupTabWithTargets[]> {
	const tabs = await getTabsForPopup()
	return await Promise.all(
		tabs.map(async (tab) => {
			const session = bridgeSessions.get(tab.tabId)
			const { visibleTargets, hiddenTargets } = await getPopupTargetVisibility(tab.tabId, tab.attached)
			return {
				...tab,
				targets: visibleTargets,
				hiddenTargets,
				selectedFrameId: getSelectedFrameId(tab.tabId),
				watcher: session ? buildWatcherStatus(tab.tabId, session) : null,
			}
		}),
	)
}

async function getPopupTargetVisibility(tabId: number, attached: boolean): Promise<{ visibleTargets: PopupTarget[]; hiddenTargets: PopupTarget[] }> {
	const targets = attached ? getPopupTargets(tabId) : []
	const pageUrl = getPageUrlForTab(tabId)
	if (!pageUrl) {
		return { visibleTargets: targets, hiddenTargets: [] }
	}

	const hiddenTargets = await filterHiddenTargets(pageUrl, targets)
	if (hiddenTargets.length === 0) {
		return { visibleTargets: targets, hiddenTargets }
	}

	return {
		visibleTargets: targets.filter((target) => !hiddenTargets.includes(target)),
		hiddenTargets,
	}
}

function createWatcherStatus(
	tabId: number,
	session: TabBridgeSession,
	watcherInfo: ReturnType<TabBridgeSession['getWatcherInfo']>,
	currentTarget: PopupWatcherStatus['currentTarget'],
): PopupWatcherStatus {
	const readiness = buildWatcherReadiness(tabId, session, watcherInfo, currentTarget)
	return {
		tabId,
		bridgeConnected: readiness.nativeHostConnected,
		nativeHostConnected: readiness.nativeHostConnected,
		watcherReady: readiness.watcherReady,
		targetReady: readiness.targetReady,
		targetState: readiness.targetState,
		watcherId: watcherInfo?.watcherId ?? null,
		watcherHost: watcherInfo?.watcherHost ?? null,
		watcherPort: watcherInfo?.watcherPort ?? null,
		nativeHostPid: watcherInfo?.pid ?? null,
		lastMessageAt: session.getLastMessageAt(),
		currentTarget,
	}
}

function buildWatcherReadiness(
	tabId: number,
	session: TabBridgeSession,
	watcherInfo: ReturnType<TabBridgeSession['getWatcherInfo']>,
	currentTarget: PopupWatcherStatus['currentTarget'],
): Pick<PopupWatcherStatus, 'nativeHostConnected' | 'watcherReady' | 'targetReady' | 'targetState'> {
	const nativeHostConnected = session.isConnected()
	const watcherReady = nativeHostConnected && Boolean(watcherInfo?.watcherId && watcherInfo.watcherHost && watcherInfo.watcherPort != null)
	const targetReady = currentTarget?.targetReady ?? getTargetReadiness(tabId, currentTarget)

	return {
		nativeHostConnected,
		watcherReady,
		targetReady,
		targetState: targetReady == null ? 'not-selected' : targetReady ? 'ready' : 'rebinding',
	}
}

/**
 * The watcher can be connected while a remembered iframe is still rebinding after reload.
 * Treat the extension's live frame map as the source of truth for whether frame-scoped
 * commands have a concrete execution target again.
 */
function getTargetReadiness(tabId: number, target: PopupWatcherStatus['currentTarget']): boolean | null {
	if (!target) {
		return null
	}

	if (!target.frameId) {
		return debuggerManager.isAttached(tabId)
	}

	const frame = debuggerManager.getFrames(tabId).find((candidate) => candidate.frameId === target.frameId)
	return Boolean(frame?.sessionId)
}

async function getTabsForPopup(): Promise<
	Array<{
		tabId: number
		url: string
		title: string
		faviconUrl?: string
		attached: boolean
	}>
> {
	return await listBrowserTabs(debuggerManager)
}

function syncSelectedFrameFromWatcher(targetId: string): void {
	const target = parseWatcherTargetId(targetId)
	if (!target) {
		return
	}

	setSelectedFrame(target.tabId, target.frameId)
}

function getSelectedFrameId(tabId: number): string | null | undefined {
	if (!selectedFrameByTabId.has(tabId)) {
		return undefined
	}

	return selectedFrameByTabId.get(tabId) ?? null
}

function parseWatcherTargetId(targetId: string): { tabId: number; frameId: string | null } | null {
	if (targetId.startsWith('tab:')) {
		const tabId = Number.parseInt(targetId.slice(4), 10)
		return Number.isFinite(tabId) ? { tabId, frameId: null } : null
	}

	if (targetId.startsWith('frame:')) {
		const [, tabIdRaw, ...frameIdParts] = targetId.split(':')
		const tabId = Number.parseInt(tabIdRaw ?? '', 10)
		const frameId = frameIdParts.join(':')
		return Number.isFinite(tabId) && frameId ? { tabId, frameId } : null
	}

	return null
}

function getPopupTargets(tabId: number): PopupTarget[] {
	const frames = debuggerManager.getFrames(tabId)
	const topFrameId = debuggerManager.getTarget(tabId)?.topFrameId ?? null
	const topFrame = frames.find((frame) => frame.frameId === topFrameId) ?? frames.find((frame) => frame.parentFrameId == null)
	if (!topFrame) {
		return []
	}

	return [
		{
			type: 'page',
			frameId: null,
			parentFrameId: null,
			title: topFrame.title || 'Page',
			url: topFrame.url,
		},
		...frames
			.filter((frame) => frame.frameId !== topFrame.frameId)
			.map((frame) => ({
				type: 'iframe' as const,
				frameId: frame.frameId,
				parentFrameId: frame.parentFrameId === topFrame.frameId ? null : frame.parentFrameId,
				title: frame.title || frame.url || `iframe ${frame.frameId.slice(0, 8)}`,
				url: frame.url,
			})),
	]
}

function getPopupTarget(tabId: number, frameId: string | null): PopupTarget | null {
	return getPopupTargets(tabId).find((target) => (target.frameId ?? null) === frameId) ?? null
}

function getRequiredIframeTarget(tabId: number, frameId: string | null): PopupTarget {
	const target = getPopupTarget(tabId, frameId)
	if (!target || target.type !== 'iframe' || !target.frameId) {
		throw new Error(`Unknown iframe target for tab ${tabId}`)
	}

	return target
}

function getPageUrlForTab(tabId: number): string | null {
	return getPopupTarget(tabId, null)?.url ?? debuggerManager.getTarget(tabId)?.url ?? null
}

async function rememberTargetSelection(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(tabId)
	if (!pageUrl) {
		return
	}

	await targetSelectionHistory.remember(pageUrl, toSelectionTarget(target))
}

async function hideTarget(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(tabId)
	if (!pageUrl) {
		return
	}

	await targetVisibilityHistory.hide(pageUrl, toSelectionTarget(target))
	if (getSelectedFrameId(tabId) !== target.frameId) {
		return
	}

	const session = bridgeSessions.get(tabId)
	session?.selectTarget(null)
	setSelectedFrame(tabId, null)
	const pageTarget = getPopupTarget(tabId, null)
	if (pageTarget) {
		await rememberTargetSelection(tabId, pageTarget)
	}
}

async function showTarget(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(tabId)
	if (!pageUrl) {
		return
	}

	await targetVisibilityHistory.show(pageUrl, toSelectionTarget(target))
}

async function filterHiddenTargets(pageUrl: string, targets: PopupTarget[]): Promise<PopupTarget[]> {
	const hiddenTargets = await targetVisibilityHistory.getHiddenTargets(pageUrl)
	if (hiddenTargets.length === 0) {
		return []
	}

	return targets.filter((target) => hiddenTargets.some((hiddenTarget) => matchesHiddenTarget(hiddenTarget, toSelectionTarget(target))))
}

async function prepareRememberedTargetSelection(tabId: number): Promise<void> {
	const pageUrl = getPageUrlForTab(tabId)
	if (!pageUrl) {
		clearPendingRememberedTarget(tabId)
		return
	}

	const remembered = await targetSelectionHistory.getByPageUrl(pageUrl)
	if (!remembered || remembered.target.type === 'page') {
		clearPendingRememberedTarget(tabId)
		return
	}

	setPendingRememberedTarget(tabId, remembered)
	await replayRememberedTargetSelection(tabId)
}

async function replayRememberedTargetSelection(tabId: number): Promise<void> {
	const remembered = pendingRememberedTargetByTabId.get(tabId)
	const session = bridgeSessions.get(tabId)
	if (!remembered || !session) {
		return
	}

	const target = matchRememberedIframeTarget(
		remembered,
		getPopupTargets(tabId).map((candidate) => toSelectionTarget(candidate)),
	)
	if (!target?.frameId) {
		return
	}

	try {
		session.selectTarget(target.frameId)
		setSelectedFrame(tabId, target.frameId)
		clearPendingRememberedTarget(tabId)
		recordEvent('info', 'bridge', `Restored iframe ${target.frameId} on tab ${tabId}`)
	} catch (error) {
		console.warn(`[ServiceWorker] Failed to restore remembered iframe for tab ${tabId}:`, error)
	}
}

function shouldReplayRememberedTarget(tabId: number, method: string): boolean {
	return pendingRememberedTargetByTabId.has(tabId) && REMEMBERED_TARGET_RETRY_EVENTS.has(method)
}

function setSelectedFrame(tabId: number, frameId: string | null): void {
	selectedFrameByTabId.set(tabId, frameId)
}

function setPendingRememberedTarget(tabId: number, remembered: RememberedTargetSelection): void {
	pendingRememberedTargetByTabId.set(tabId, remembered)
}

function clearPendingRememberedTarget(tabId: number): void {
	pendingRememberedTargetByTabId.delete(tabId)
}

function toSelectionTarget(target: PopupTarget): SelectionTarget {
	return {
		type: target.type,
		frameId: target.frameId,
		title: target.title,
		url: target.url,
	}
}

console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
void syncActionBadge()

export { debuggerManager, bridgeSessions }
