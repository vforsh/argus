export type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
}

export type TabInfo = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	selectedFrameId?: string | null
	targets?: PopupTarget[]
	hiddenTargets?: PopupTarget[]
	watcher: PopupWatcherStatus | null
}

export type CurrentTargetSummary = {
	tabId: number
	type: 'page' | 'iframe'
	title: string | null
	url: string | null
	targetId: string
	frameId: string | null
	attachedAt: number
	targetReady: boolean | null
}

export type PopupWatcherStatus = {
	tabId: number
	bridgeConnected: boolean
	nativeHostConnected: boolean
	watcherReady: boolean
	targetReady: boolean | null
	targetState: 'ready' | 'rebinding' | 'not-selected'
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	nativeHostPid: number | null
	lastMessageAt: number | null
	currentTarget: CurrentTargetSummary | null
}
