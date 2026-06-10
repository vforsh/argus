export type ExtensionBrowserTab = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	watcherId?: string
}

export type ExtensionTabsResponse = {
	ok: true
	tabs: ExtensionBrowserTab[]
}
