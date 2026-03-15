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
	selectedFrameId: string | null
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
				const restoreSelection = updateSelectedFrame(tabId, frameId)
				const sent = bridgeClient.send({
					type: 'target_selected',
					tabId,
					frameId,
				})
				if (!sent) {
					restoreSelection()
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
			selectedFrameId: selectedFrameByTabId.get(tab.tabId) ?? null,
		})),
	)
}

function updateSelectedFrame(tabId: number, frameId: string | null): () => void {
	const previousFrameId = selectedFrameByTabId.get(tabId) ?? null
	selectedFrameByTabId.set(tabId, frameId)
	return () => {
		selectedFrameByTabId.set(tabId, previousFrameId)
	}
}

function getCurrentTargetSummary(tabs: PopupTabWithTargets[]): CurrentTargetSummary | null {
	const attachedTabs = tabs.filter((tab) => tab.attached)
	const selectedTab = attachedTabs.find((tab) => (tab.selectedFrameId ?? null) !== null) ?? attachedTabs[0]
	if (!selectedTab) {
		return null
	}

	const selectedTarget =
		selectedTab.targets.find((target) => (target.frameId ?? null) === (selectedTab.selectedFrameId ?? null)) ?? selectedTab.targets[0]

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

async function getPopupTargets(tabId: number): Promise<PopupTarget[]> {
	const frameTree = (await debuggerManager.sendCommand(tabId, 'Page.getFrameTree')) as {
		frameTree?: {
			frame?: { id?: string; parentId?: string; name?: string; url?: string }
			childFrames?: unknown[]
		}
	}

	const tree = frameTree.frameTree
	if (!tree?.frame?.id) {
		return []
	}

	const targets: PopupTarget[] = [
		{
			type: 'page',
			frameId: null,
			parentFrameId: null,
			title: tree.frame.name || 'Page',
			url: tree.frame.url ?? '',
		},
	]

	collectPopupFrames(tree, targets, tree.frame.id)
	return targets
}

function collectPopupFrames(
	node: {
		frame?: { id?: string; parentId?: string; name?: string; url?: string }
		childFrames?: unknown[]
	},
	targets: PopupTarget[],
	topFrameId: string,
): void {
	for (const child of node.childFrames ?? []) {
		const frameNode = child as {
			frame?: { id?: string; parentId?: string; name?: string; url?: string }
			childFrames?: unknown[]
		}
		if (!frameNode.frame?.id) {
			continue
		}

		targets.push({
			type: 'iframe',
			frameId: frameNode.frame.id,
			parentFrameId: frameNode.frame.parentId === topFrameId ? null : (frameNode.frame.parentId ?? null),
			title: frameNode.frame.name || frameNode.frame.url || `iframe ${frameNode.frame.id.slice(0, 8)}`,
			url: frameNode.frame.url ?? '',
		})

		collectPopupFrames(frameNode, targets, topFrameId)
	}
}

// Attempt to connect to bridge on startup
// We do this lazily - the bridge may not be running yet
console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
bridgeClient.connect()

// Export for testing purposes
export { debuggerManager, bridgeClient, cdpProxy }
