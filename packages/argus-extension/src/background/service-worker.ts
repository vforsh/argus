/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Owns one debugger manager plus one Native Messaging bridge session per attached tab,
 * and answers popup messages (see `popup-protocol.ts` for the message shapes).
 */

import { DebuggerManager } from './debugger-manager.js'
import { TabBridgeSession, type TabBridgeSessionOptions } from './tab-bridge-session.js'
import { ControlBridgeSession, type TabActionResult } from './control-bridge-session.js'
import { type RememberedTargetSelection, TargetSelectionHistoryStore, matchRememberedIframeTarget } from './target-selection-history.js'
import { TargetVisibilityHistoryStore, matchesHiddenTarget } from './target-visibility-history.js'
import { listBrowserTabs } from './tab-list.js'
import { syncActionBadge } from './action-badge.js'
import { buildWatcherStatus } from './watcher-status.js'
import {
	getPageUrlForTab,
	getPopupTarget,
	getPopupTargets,
	getRequiredIframeTarget,
	parseWatcherTargetId,
	toSelectionTarget,
} from './popup-targets.js'
import type {
	PopupActionMessage,
	PopupEvent,
	PopupResponse,
	PopupStatusPayload,
	PopupTabWithTargets,
	PopupTarget,
	PopupWatcherStatus,
} from './popup-protocol.js'
import type { ControlDiagnostics, TabInfo } from '../types/messages.js'

const debuggerManager = new DebuggerManager()
const controlBridgeSession = new ControlBridgeSession(debuggerManager, {
	onWatcherInfo: (info) => {
		recordEvent('info', 'bridge', `Control watcher ready: ${info.watcherId} (pid ${info.pid})`)
	},
	onAttachTabWatcher: attachTabFromControl,
	onDetachTabWatcher: detachTabFromControl,
	getWatcherIdForTab,
	getDiagnostics: buildControlDiagnostics,
	onDisconnect: () => {
		recordEvent('error', 'bridge', 'Control native host disconnected')
	},
})
const bridgeSessions = new Map<number, TabBridgeSession>()
const selectedFrameByTabId = new Map<number, string | null>()
// Re-try a remembered iframe while Chrome is still populating frame metadata for a fresh attach.
const pendingRememberedTargetByTabId = new Map<number, RememberedTargetSelection>()
const targetSelectionHistory = new TargetSelectionHistoryStore()
const targetVisibilityHistory = new TargetVisibilityHistoryStore()
const recentEvents: PopupEvent[] = []
const MAX_RECENT_EVENTS = 8
const REMEMBERED_TARGET_RETRY_EVENTS = new Set(['Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated'])

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

debuggerManager.onDetach((tabId, reason) => {
	clearTabState(tabId)
	recordEvent('error', 'debugger', `Tab ${tabId} detached: ${reason}`)
	void syncActionBadge(debuggerManager)
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

chrome.runtime.onStartup.addListener(() => {
	ensureControlBridgeSession()
})

chrome.runtime.onInstalled.addListener(() => {
	ensureControlBridgeSession()
})

async function handlePopupMessage(message: PopupActionMessage, sendResponse: (response: unknown) => void): Promise<void> {
	ensureControlBridgeSession()
	pruneStaleBridgeSessions()
	const response = await buildPopupResponse(message)
	await syncActionBadge(debuggerManager)
	sendResponse(response)
}

function ensureControlBridgeSession(): void {
	if (controlBridgeSession.isConnected()) {
		return
	}
	controlBridgeSession.connect()
}

ensureControlBridgeSession()

async function attachTabFromControl(tabId: number, options: TabBridgeSessionOptions = {}): Promise<TabActionResult> {
	try {
		const session = await attachBridgeSession(tabId, options)
		setSelectedFrame(tabId, null)
		await prepareRememberedTargetSelection(tabId)
		recordEvent('info', 'bridge', `Control attached tab ${tabId}`)
		void syncActionBadge(debuggerManager)

		const tab = await getTabInfo(tabId)
		if (!tab) {
			return { ok: false, error: `Tab ${tabId} is no longer available` }
		}

		return { ok: true, tab, watcherId: session.getWatcherInfo()?.watcherId }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

async function detachTabFromControl(tabId: number): Promise<TabActionResult> {
	try {
		await detachTab(tabId)
		recordEvent('info', 'bridge', `Control detached tab ${tabId}`)
		void syncActionBadge(debuggerManager)

		const tab = await getTabInfo(tabId)
		if (!tab) {
			return { ok: false, error: `Tab ${tabId} is no longer available` }
		}

		return { ok: true, tab }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
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
				const target = getPopupTarget(debuggerManager, tabId, frameId)
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
				const target = getRequiredIframeTarget(debuggerManager, tabId, message.frameId ?? null)
				await hideTarget(tabId, target)
				recordEvent('info', 'popup', `Hid iframe ${target.frameId} on tab ${tabId}`)
				return { success: true }
			}

			case 'showTarget': {
				const tabId = requireTabId(message)
				const target = getRequiredIframeTarget(debuggerManager, tabId, message.frameId ?? null)
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

async function attachBridgeSession(tabId: number, options: TabBridgeSessionOptions = {}): Promise<TabBridgeSession> {
	const existing = bridgeSessions.get(tabId)
	if (existing) {
		await connectBridgeSession(tabId, existing)
		return existing
	}

	const session = new TabBridgeSession(
		tabId,
		debuggerManager,
		{
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
				void syncActionBadge(debuggerManager)
			},
		},
		options,
	)
	bridgeSessions.set(tabId, session)
	await connectBridgeSession(tabId, session)
	return session
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

function buildControlDiagnostics(): ControlDiagnostics {
	const controlInfo = controlBridgeSession.getWatcherInfo()
	return {
		extensionId: chrome.runtime.id ?? null,
		extensionVersion: chrome.runtime.getManifest().version ?? null,
		control: {
			connected: controlBridgeSession.isConnected(),
			watcherId: controlInfo?.watcherId ?? null,
			watcherHost: controlInfo?.watcherHost ?? null,
			watcherPort: controlInfo?.watcherPort ?? null,
			pid: controlInfo?.pid ?? null,
			lastMessageAt: controlBridgeSession.getLastMessageAt(),
		},
		tabWatchers: [...bridgeSessions.entries()].map(([tabId, session]) => buildTabBridgeStatus(tabId, session)),
		recentEvents,
	}
}

function buildTabBridgeStatus(tabId: number, session: TabBridgeSession): ControlDiagnostics['tabWatchers'][number] {
	const watcher = session.getWatcherInfo()
	const target = session.getTargetInfo()
	return {
		tabId,
		connected: session.isConnected(),
		watcherId: watcher?.watcherId ?? null,
		watcherHost: watcher?.watcherHost ?? null,
		watcherPort: watcher?.watcherPort ?? null,
		pid: watcher?.pid ?? null,
		targetId: target?.targetId ?? null,
		targetTitle: target?.title ?? null,
		targetUrl: target?.url ?? null,
		targetReady: target?.targetReady ?? null,
		lastMessageAt: session.getLastMessageAt(),
	}
}

async function getTabInfo(tabId: number): Promise<TabInfo | null> {
	const tabs = await listBrowserTabs(debuggerManager, undefined, {
		getWatcherIdForTab,
	})
	return tabs.find((tab) => tab.tabId === tabId) ?? null
}

function getWatcherIdForTab(tabId: number): string | null {
	return bridgeSessions.get(tabId)?.getWatcherInfo()?.watcherId ?? null
}

function getWatcherStatuses(): PopupWatcherStatus[] {
	return [...bridgeSessions.entries()]
		.map(([tabId, session]) => buildWatcherStatus(debuggerManager, tabId, session))
		.filter((status): status is PopupWatcherStatus => status !== null)
}

async function getTabsWithTargets(): Promise<PopupTabWithTargets[]> {
	const tabs = await listBrowserTabs(debuggerManager)
	return await Promise.all(
		tabs.map(async (tab) => {
			const session = bridgeSessions.get(tab.tabId)
			const { visibleTargets, hiddenTargets } = await getPopupTargetVisibility(tab.tabId, tab.attached)
			return {
				...tab,
				targets: visibleTargets,
				hiddenTargets,
				selectedFrameId: getSelectedFrameId(tab.tabId),
				watcher: session ? buildWatcherStatus(debuggerManager, tab.tabId, session) : null,
			}
		}),
	)
}

async function getPopupTargetVisibility(tabId: number, attached: boolean): Promise<{ visibleTargets: PopupTarget[]; hiddenTargets: PopupTarget[] }> {
	const targets = attached ? getPopupTargets(debuggerManager, tabId) : []
	const pageUrl = getPageUrlForTab(debuggerManager, tabId)
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

async function rememberTargetSelection(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(debuggerManager, tabId)
	if (!pageUrl) {
		return
	}

	await targetSelectionHistory.remember(pageUrl, toSelectionTarget(target))
}

async function hideTarget(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(debuggerManager, tabId)
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
	const pageTarget = getPopupTarget(debuggerManager, tabId, null)
	if (pageTarget) {
		await rememberTargetSelection(tabId, pageTarget)
	}
}

async function showTarget(tabId: number, target: PopupTarget): Promise<void> {
	const pageUrl = getPageUrlForTab(debuggerManager, tabId)
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
	const pageUrl = getPageUrlForTab(debuggerManager, tabId)
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
		getPopupTargets(debuggerManager, tabId).map((candidate) => toSelectionTarget(candidate)),
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

console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
void syncActionBadge(debuggerManager)

export { debuggerManager, bridgeSessions }
