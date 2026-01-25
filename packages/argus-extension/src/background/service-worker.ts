/**
 * Service Worker - Main entry point for the Argus CDP Bridge extension.
 * Orchestrates the DebuggerManager, BridgeClient, and CdpProxy.
 */

import { DebuggerManager } from './debugger-manager.js'
import { BridgeClient } from './bridge-client.js'
import { CdpProxy } from './cdp-proxy.js'
import type { TabInfo } from '../types/messages.js'

// Initialize core components
const debuggerManager = new DebuggerManager()
const bridgeClient = new BridgeClient('com.vforsh.argus.bridge')
const cdpProxy = new CdpProxy(debuggerManager, bridgeClient)

// Track connection status for badge
let isConnected = false

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
	(message: { action: string; tabId?: number }, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
		handlePopupMessage(message, sendResponse)
		return true // Async response
	},
)

async function handlePopupMessage(message: { action: string; tabId?: number }, sendResponse: (response: unknown) => void): Promise<void> {
	try {
		switch (message.action) {
			case 'getTabs': {
				const tabs = await cdpProxy.getTabsForPopup()
				sendResponse({ success: true, tabs })
				break
			}

			case 'attach': {
				if (message.tabId === undefined) {
					sendResponse({ success: false, error: 'No tabId provided' })
					return
				}
				await cdpProxy.attachTab(message.tabId)
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
				updateBadge()
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

// Attempt to connect to bridge on startup
// We do this lazily - the bridge may not be running yet
console.log('[ServiceWorker] Argus CDP Bridge extension loaded')
bridgeClient.connect()

// Export for testing purposes
export { debuggerManager, bridgeClient, cdpProxy }
