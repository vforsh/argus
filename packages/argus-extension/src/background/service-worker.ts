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
import { listBrowserTabs } from './tab-list.js'

const debuggerManager = new DebuggerManager()
const bridgeSessions = new Map<number, TabBridgeSession>()
const selectedFrameByTabId = new Map<number, string | null>()
// Re-try a remembered iframe while Chrome is still populating frame metadata for a fresh attach.
const pendingRememberedTargetByTabId = new Map<number, RememberedTargetSelection>()
const targetSelectionHistory = new TargetSelectionHistoryStore()
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
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	nativeHostPid: number | null
	lastMessageAt: number | null
	currentTarget: {
		type: 'page' | 'iframe'
		title: string | null
		url: string | null
		targetId: string
		frameId: string | null
		attachedAt: number
	} | null
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
				}
			: null,
	)
}

async function getTabsWithTargets(): Promise<PopupTabWithTargets[]> {
	const tabs = await getTabsForPopup()
	return tabs.map((tab) => {
		const session = bridgeSessions.get(tab.tabId)
		return {
			...tab,
			targets: tab.attached ? getPopupTargets(tab.tabId) : [],
			selectedFrameId: getSelectedFrameId(tab.tabId),
			watcher: session ? buildWatcherStatus(tab.tabId, session) : null,
		}
	})
}

function createWatcherStatus(
	tabId: number,
	session: TabBridgeSession,
	watcherInfo: ReturnType<TabBridgeSession['getWatcherInfo']>,
	currentTarget: PopupWatcherStatus['currentTarget'],
): PopupWatcherStatus {
	return {
		tabId,
		bridgeConnected: session.isConnected(),
		watcherId: watcherInfo?.watcherId ?? null,
		watcherHost: watcherInfo?.watcherHost ?? null,
		watcherPort: watcherInfo?.watcherPort ?? null,
		nativeHostPid: watcherInfo?.pid ?? null,
		lastMessageAt: session.getLastMessageAt(),
		currentTarget,
	}
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
