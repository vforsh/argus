import type { ExtensionControlBridgeStatus, ExtensionTabBridgeStatus, ExtensionRecentEvent } from '../native-messaging.js'

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

/** Result of an extension-control attach/detach request after the extension has applied it. */
export type ExtensionTabActionResponse = {
	ok: true
	tab: ExtensionBrowserTab
	watcherId?: string
}

/** Live diagnostics from the extension-control watcher and connected browser extension. */
export type ExtensionDiagnosticsResponse = {
	ok: true
	extension: {
		id: string | null
		version: string | null
	}
	control: ExtensionControlBridgeStatus
	tabWatchers: ExtensionTabBridgeStatus[]
	recentEvents: ExtensionRecentEvent[]
}
