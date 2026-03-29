/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Owns one debugger manager plus one Native Messaging bridge session per attached tab.
 */

import { DebuggerManager } from './debugger-manager.js'
import { TabBridgeSession } from './tab-bridge-session.js'

const debuggerManager = new DebuggerManager()
const bridgeSessions = new Map<number, TabBridgeSession>()
const selectedFrameByTabId = new Map<number, string | null>()
const recentEvents: PopupEvent[] = []
const MAX_RECENT_EVENTS = 8

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

function updateBadge(): void {
	const attachedCount = debuggerManager.listAttached().length

	if (attachedCount > 0) {
		chrome.action.setBadgeText({ text: String(attachedCount) })
		chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' })
		return
	}

	chrome.action.setBadgeText({ text: '' })
}

debuggerManager.onDetach((tabId, reason) => {
	selectedFrameByTabId.delete(tabId)
	destroyBridgeSession(tabId)
	recordEvent('error', 'debugger', `Tab ${tabId} detached: ${reason}`)
	updateBadge()
})

chrome.runtime.onMessage.addListener(
	(message: PopupActionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
		handlePopupMessage(message, sendResponse)
		return true
	},
)

async function handlePopupMessage(message: PopupActionMessage, sendResponse: (response: unknown) => void): Promise<void> {
	try {
		switch (message.action) {
			case 'getTargets': {
				const tabsWithTargets = await getTabsWithTargets()
				sendResponse({ success: true, tabs: tabsWithTargets })
				break
			}

			case 'attach': {
				const tabId = requireTabId(message, sendResponse)
				if (tabId === null) {
					return
				}

				await attachBridgeSession(tabId)
				selectedFrameByTabId.set(tabId, null)
				recordEvent('info', 'popup', `Attached tab ${tabId}`)
				updateBadge()
				sendResponse({ success: true })
				break
			}

			case 'detach': {
				const tabId = requireTabId(message, sendResponse)
				if (tabId === null) {
					return
				}

				const session = bridgeSessions.get(tabId)
				if (session) {
					await session.detach()
				} else {
					await debuggerManager.detach(tabId)
				}
				destroyBridgeSession(tabId)
				selectedFrameByTabId.delete(tabId)
				recordEvent('info', 'popup', `Detached tab ${tabId}`)
				updateBadge()
				sendResponse({ success: true })
				break
			}

			case 'selectTarget': {
				const tabId = requireTabId(message, sendResponse)
				if (tabId === null) {
					return
				}

				const session = bridgeSessions.get(tabId)
				if (!session) {
					sendResponse({ success: false, error: `No watcher bridge for tab ${tabId}` })
					return
				}

				const frameId = message.frameId ?? null
				session.selectTarget(frameId)
				recordEvent('info', 'popup', `Selected ${frameId ? `iframe ${frameId}` : 'page'} on tab ${tabId}`)
				sendResponse({ success: true })
				break
			}

			case 'getStatus': {
				sendResponse({
					success: true,
					status: {
						bridgeConnected: [...bridgeSessions.values()].some((session) => session.isConnected()),
						attachedTabs: debuggerManager.listAttached().map((target) => ({
							tabId: target.tabId,
							url: target.url,
							title: target.title,
						})),
						watchers: getWatcherStatuses(),
						recentEvents,
					},
				})
				break
			}

			default:
				sendResponse({ success: false, error: `Unknown action: ${message.action}` })
		}
	} catch (err) {
		recordEvent('error', 'popup', err instanceof Error ? err.message : 'Unknown popup error')
		sendResponse({
			success: false,
			error: err instanceof Error ? err.message : 'Unknown error',
		})
	}
}

function requireTabId(message: PopupActionMessage, sendResponse: (response: unknown) => void): number | null {
	if (message.tabId !== undefined) {
		return message.tabId
	}

	sendResponse({ success: false, error: 'No tabId provided' })
	return null
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
			destroyBridgeSession(tabId)
			updateBadge()
		},
	})
	bridgeSessions.set(tabId, session)
	await connectBridgeSession(tabId, session)
}

async function connectBridgeSession(tabId: number, session: TabBridgeSession): Promise<void> {
	try {
		await session.connectAndAttach()
	} catch (error) {
		destroyBridgeSession(tabId)
		throw error
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
	return Promise.all(
		tabs.map(async (tab) => {
			const session = bridgeSessions.get(tab.tabId)
			return {
				...tab,
				targets: tab.attached ? await getPopupTargets(tab.tabId) : [],
				selectedFrameId: getSelectedFrameId(tab.tabId),
				watcher: session ? buildWatcherStatus(tab.tabId, session) : null,
			}
		}),
	)
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
	const chromeTabs = await chrome.tabs.query({})
	const attachedTargets = debuggerManager.listAttached()
	const attachedTabIds = new Set(attachedTargets.map((target) => target.tabId))

	return chromeTabs
		.filter((tab) => tab.id !== undefined && tab.url !== undefined)
		.filter((tab) => !tab.url!.startsWith('chrome://') && !tab.url!.startsWith('chrome-extension://'))
		.map((tab) => ({
			tabId: tab.id!,
			url: tab.url!,
			title: tab.title ?? '',
			faviconUrl: tab.favIconUrl,
			attached: attachedTabIds.has(tab.id!),
		}))
}

function syncSelectedFrameFromWatcher(targetId: string): void {
	const target = parseWatcherTargetId(targetId)
	if (!target) {
		return
	}

	selectedFrameByTabId.set(target.tabId, target.frameId)
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

async function getPopupTargets(tabId: number): Promise<PopupTarget[]> {
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

console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
updateBadge()

export { debuggerManager, bridgeSessions }
