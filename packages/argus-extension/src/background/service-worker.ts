/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Orchestrates the DebuggerManager, BridgeClient, and CdpProxy.
 */

import type { HostToExtension } from '../types/messages.js'
import { DebuggerManager } from './debugger-manager.js'
import { BridgeClient } from './bridge-client.js'
import { CdpProxy } from './cdp-proxy.js'

// Initialize core components
const debuggerManager = new DebuggerManager()
const bridgeClient = new BridgeClient('com.vforsh.argus.bridge')
const cdpProxy = new CdpProxy(debuggerManager, bridgeClient)

// Track connection status for badge
let isConnected = false
let watcherId: string | null = null
let watcherHost: string | null = null
let watcherPort: number | null = null
let nativeHostPid: number | null = null
let lastBridgeMessageAt: number | null = null
let watcherTargetInfo: { targetId: string; title: string | null; url: string | null; attachedAt: number } | null = null
// Popup selection is tab-scoped: one attached tab can expose multiple virtual iframe targets.
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

type PopupTabWithTargets = Awaited<ReturnType<typeof cdpProxy.getTabsForPopup>>[number] & {
	targets: PopupTarget[]
	selectedFrameId?: string | null
}

type CurrentTargetSummary = {
	tabId: number
	type: 'page' | 'iframe'
	title: string | null
	url: string
	targetId: string
	frameId: string | null
	attachedAt: number | null
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

// Update extension badge based on state
function updateBadge(): void {
	const attachedCount = debuggerManager.listAttached().length

	if (attachedCount > 0) {
		chrome.action.setBadgeText({ text: String(attachedCount) })
		chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' }) // Green
	} else if (isConnected) {
		chrome.action.setBadgeText({ text: '' })
	} else {
		chrome.action.setBadgeText({ text: '!' })
		chrome.action.setBadgeBackgroundColor({ color: '#FF5722' }) // Orange
	}
}

// Bridge connection handlers
bridgeClient.onConnect(() => {
	console.log('[ServiceWorker] Bridge connected')
	isConnected = true
	recordEvent('info', 'bridge', 'Native host connected')
	updateBadge()
})

bridgeClient.onDisconnect(() => {
	console.log('[ServiceWorker] Bridge disconnected')
	isConnected = false
	recordEvent('error', 'bridge', 'Native host disconnected')
	updateBadge()
})

// Update badge when tabs attach/detach
debuggerManager.onDetach((tabId, reason) => {
	selectedFrameByTabId.delete(tabId)
	if (watcherTargetInfo?.targetId.startsWith(`tab:${tabId}`) || watcherTargetInfo?.targetId.startsWith(`frame:${tabId}:`)) {
		watcherTargetInfo = null
	}
	recordEvent('error', 'debugger', `Tab ${tabId} detached: ${reason}`)
	updateBadge()
})

bridgeClient.onMessage((message: HostToExtension) => {
	lastBridgeMessageAt = Date.now()
	if (message.type !== 'host_info') {
		if (message.type === 'target_info') {
			watcherTargetInfo = {
				targetId: message.targetId,
				title: message.title,
				url: message.url,
				attachedAt: message.attachedAt,
			}
			syncSelectedFrameFromWatcher(message.targetId)
		}
		return
	}

	watcherId = message.watcherId
	watcherHost = message.watcherHost
	watcherPort = message.watcherPort
	nativeHostPid = message.pid
	recordEvent('info', 'bridge', `Watcher ready: ${message.watcherId} (pid ${message.pid})`)
})

// Handle messages from popup
chrome.runtime.onMessage.addListener(
	(message: PopupActionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
		handlePopupMessage(message, sendResponse)
		return true // Async response
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

				await cdpProxy.attachTab(tabId)
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

				await cdpProxy.detachTab(tabId)
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

				const frameId = message.frameId ?? null
				const sent = bridgeClient.send({
					type: 'target_selected',
					tabId,
					frameId,
				})
				if (!sent) {
					recordEvent('error', 'popup', `Failed to select target for tab ${tabId}: bridge disconnected`)
					sendResponse({ success: false, error: 'Bridge is not connected' })
					return
				}
				recordEvent('info', 'popup', `Selected ${frameId ? `iframe ${frameId}` : 'page'} on tab ${tabId}`)
				sendResponse({ success: true })
				break
			}

			case 'getStatus': {
				const tabsWithTargets = await getTabsWithTargets()
				sendResponse({
					success: true,
					status: {
						bridgeConnected: isConnected,
						watcherId,
						watcherHost,
						watcherPort,
						nativeHostPid,
						lastMessageAt: lastBridgeMessageAt,
						attachedTabs: debuggerManager.listAttached().map((t) => ({
							tabId: t.tabId,
							url: t.url,
							title: t.title,
						})),
						currentTarget: getCurrentTargetSummary(tabsWithTargets),
						recentEvents,
					},
				})
				break
			}

			case 'connectBridge': {
				const connected = bridgeClient.connect()
				sendResponse({ success: connected })
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

async function getTabsWithTargets(): Promise<PopupTabWithTargets[]> {
	const tabs = await cdpProxy.getTabsForPopup()
	return Promise.all(
		tabs.map(async (tab) => ({
			...tab,
			targets: tab.attached ? await getPopupTargets(tab.tabId) : [],
			selectedFrameId: getSelectedFrameId(tab.tabId),
		})),
	)
}

function syncSelectedFrameFromWatcher(targetId: string): void {
	const target = parseWatcherTargetId(targetId)
	if (!target) {
		return
	}

	selectedFrameByTabId.clear()
	selectedFrameByTabId.set(target.tabId, target.frameId)
}

function getCurrentTargetSummary(tabs: PopupTabWithTargets[]): CurrentTargetSummary | null {
	const attachedTabs = tabs.filter((tab) => tab.attached)
	const watcherTarget = watcherTargetInfo ? parseWatcherTargetId(watcherTargetInfo.targetId) : null
	const selectedTab = findSelectedTab(attachedTabs, watcherTarget)
	if (!selectedTab) {
		return null
	}

	const selectedTarget = findSelectedTarget(selectedTab, watcherTarget?.frameId ?? null)
	if (!selectedTarget) {
		return null
	}

	const targetId = selectedTarget.frameId ? formatFrameTargetId(selectedTab.tabId, selectedTarget.frameId) : formatPageTargetId(selectedTab.tabId)
	const targetInfo = watcherTargetInfo?.targetId === targetId ? watcherTargetInfo : null

	return {
		tabId: selectedTab.tabId,
		type: selectedTarget.type,
		title: (targetInfo?.title ?? selectedTarget.title) || null,
		url: (targetInfo?.url ?? selectedTarget.url) || selectedTab.url,
		targetId,
		frameId: selectedTarget.frameId,
		attachedAt: targetInfo?.attachedAt ?? debuggerManager.getTarget(selectedTab.tabId)?.attachedAt ?? null,
	}
}

function formatPageTargetId(tabId: number): string {
	return `tab:${tabId}`
}

function formatFrameTargetId(tabId: number, frameId: string): string {
	return `frame:${tabId}:${frameId}`
}

function getSelectedFrameId(tabId: number): string | null | undefined {
	if (!selectedFrameByTabId.has(tabId)) {
		return undefined
	}

	return selectedFrameByTabId.get(tabId) ?? null
}

function findSelectedTab(
	attachedTabs: PopupTabWithTargets[],
	watcherTarget: { tabId: number; frameId: string | null } | null,
): PopupTabWithTargets | null {
	if (!watcherTarget) {
		return attachedTabs[0] ?? null
	}

	return attachedTabs.find((tab) => tab.tabId === watcherTarget.tabId) ?? null
}

function findSelectedTarget(tab: PopupTabWithTargets, frameId: string | null): PopupTarget | null {
	const effectiveFrameId = frameId ?? tab.selectedFrameId ?? null
	return tab.targets.find((target) => (target.frameId ?? null) === effectiveFrameId) ?? tab.targets[0] ?? null
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

// Attempt to connect to bridge on startup
// We do this lazily - the bridge may not be running yet
console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
bridgeClient.connect()

// Export for testing purposes
export { debuggerManager, bridgeClient, cdpProxy }
