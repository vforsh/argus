import type { DebuggerManager } from './debugger-manager.js'
import type { TabInfo } from '../types/messages.js'

type TabFilter = {
	url?: string
	title?: string
}

/**
 * Shared tab-list query for popup UI and native-host requests so both surfaces stay in sync.
 */
export const listBrowserTabs = async (debuggerManager: DebuggerManager, filter?: TabFilter): Promise<TabInfo[]> => {
	const chromeTabs = await chrome.tabs.query({})
	const attachedTargets = debuggerManager.listAttached()
	const attachedTabIds = new Set(attachedTargets.map((target) => target.tabId))

	let tabs = chromeTabs
		.filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => tab.id !== undefined && tab.url !== undefined)
		.filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://'))
		.map((tab) => ({
			tabId: tab.id,
			url: tab.url,
			title: tab.title ?? '',
			faviconUrl: tab.favIconUrl,
			attached: attachedTabIds.has(tab.id),
		}))

	if (filter?.url) {
		const urlFilter = filter.url.toLowerCase()
		tabs = tabs.filter((tab) => tab.url.toLowerCase().includes(urlFilter))
	}

	if (filter?.title) {
		const titleFilter = filter.title.toLowerCase()
		tabs = tabs.filter((tab) => tab.title.toLowerCase().includes(titleFilter))
	}

	tabs.sort((left, right) => Number(right.attached) - Number(left.attached))

	return tabs
}
