import type { DebuggerManager } from './debugger-manager.js'

let badgeSyncChain: Promise<void> = Promise.resolve()

/**
 * Serialize badge writes and reconcile on popup reads so an external detach from Chrome's
 * debugger infobar cannot leave stale badge text behind.
 */
export function syncActionBadge(debuggerManager: DebuggerManager): Promise<void> {
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
