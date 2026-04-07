export type ExtensionBrowserTab = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
}

export type ExtensionTabsResponse = {
	ok: true
	tabs: ExtensionBrowserTab[]
}
