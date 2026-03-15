/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Orchestrates the DebuggerManager, BridgeClient, and CdpProxy.
 */

import { DebuggerManager } from './debugger-manager.js'
import { BridgeClient } from './bridge-client.js'
import { CdpProxy } from './cdp-proxy.js'

// Initialize core components
const debuggerManager = new DebuggerManager()
const bridgeClient = new BridgeClient('com.vforsh.argus.bridge')
const cdpProxy = new CdpProxy(debuggerManager, bridgeClient)

// Track connection status for badge
let isConnected = false
// Popup selection is tab-scoped: one attached tab can expose multiple virtual iframe targets.
const selectedFrameByTabId = new Map<number, string | null>()

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
	updateBadge()
})

bridgeClient.onDisconnect(() => {
	console.log('[ServiceWorker] Bridge disconnected')
	isConnected = false
	updateBadge()
})

// Update badge when tabs attach/detach
debuggerManager.onDetach(() => {
	updateBadge()
})

// Handle messages from popup
chrome.runtime.onMessage.addListener(
	(
		message: { action: string; tabId?: number; frameId?: string | null },
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		handlePopupMessage(message, sendResponse)
		return true // Async response
	},
)

async function handlePopupMessage(
	message: { action: string; tabId?: number; frameId?: string | null },
	sendResponse: (response: unknown) => void,
): Promise<void> {
	try {
		switch (message.action) {
			case 'getTargets': {
				const tabsWithTargets = await getTabsWithTargets()
				sendResponse({ success: true, tabs: tabsWithTargets })
				break
			}

			case 'attach': {
				if (message.tabId === undefined) {
					sendResponse({ success: false, error: 'No tabId provided' })
					return
				}
				await cdpProxy.attachTab(message.tabId)
				selectedFrameByTabId.set(message.tabId, null)
				updateBadge()
				sendResponse({ success: true })
				break
			}

			case 'detach': {
				if (message.tabId === undefined) {
					sendResponse({ success: false, error: 'No tabId provided' })
					return
				}
				await cdpProxy.detachTab(message.tabId)
				selectedFrameByTabId.delete(message.tabId)
				updateBadge()
				sendResponse({ success: true })
				break
			}

			case 'selectTarget': {
				if (message.tabId === undefined) {
					sendResponse({ success: false, error: 'No tabId provided' })
					return
				}
				const restoreSelection = updateSelectedFrame(message.tabId, message.frameId ?? null)
				const sent = bridgeClient.send({
					type: 'target_selected',
					tabId: message.tabId,
					frameId: message.frameId ?? null,
				})
				if (!sent) {
					restoreSelection()
					sendResponse({ success: false, error: 'Bridge is not connected' })
					return
				}
				sendResponse({ success: true })
				break
			}

			case 'getStatus': {
				sendResponse({
					success: true,
					status: {
						bridgeConnected: isConnected,
						attachedTabs: debuggerManager.listAttached().map((t) => ({
							tabId: t.tabId,
							url: t.url,
							title: t.title,
						})),
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
		sendResponse({
			success: false,
			error: err instanceof Error ? err.message : 'Unknown error',
		})
	}
}

async function getTabsWithTargets(): Promise<
	Array<Awaited<ReturnType<typeof cdpProxy.getTabsForPopup>>[number] & { targets: PopupTarget[]; selectedFrameId: string | null }>
> {
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

type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
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
