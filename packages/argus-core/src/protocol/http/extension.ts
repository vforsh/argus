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

/** Runtime state for the extension-control native messaging bridge. */
export type ExtensionControlBridgeStatus = {
	connected: boolean
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	pid: number | null
	lastMessageAt: number | null
}

/** Runtime state for one tab-scoped extension watcher bridge. */
export type ExtensionTabBridgeStatus = {
	tabId: number
	connected: boolean
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	pid: number | null
	targetId: string | null
	targetTitle: string | null
	targetUrl: string | null
	targetReady: boolean | null
	lastMessageAt: number | null
}

/** Recent extension-side event surfaced for diagnostics. */
export type ExtensionRecentEvent = {
	ts: number
	level: 'info' | 'error'
	source: 'popup' | 'bridge' | 'debugger'
	message: string
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
