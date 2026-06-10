/**
 * Message protocol between the popup UI and the background service worker.
 * The popup mirrors these shapes in `src/popup/types.ts`; keep them in sync.
 */

import type { TabInfo } from '../types/messages.js'

export type PopupEvent = {
	ts: number
	level: 'info' | 'error'
	source: 'bridge' | 'debugger' | 'popup'
	message: string
}

export type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
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
	currentTarget: PopupCurrentTarget | null
}

export type PopupCurrentTarget = {
	type: 'page' | 'iframe'
	title: string | null
	url: string | null
	targetId: string
	frameId: string | null
	attachedAt: number
	targetReady: boolean | null
}

export type PopupStatusPayload = {
	bridgeConnected: boolean
	attachedTabs: Array<{
		tabId: number
		url: string
		title: string
	}>
	watchers: PopupWatcherStatus[]
	recentEvents: PopupEvent[]
}

export type PopupTabWithTargets = TabInfo & {
	targets: PopupTarget[]
	hiddenTargets: PopupTarget[]
	selectedFrameId?: string | null
	watcher: PopupWatcherStatus | null
}

export type PopupActionMessage = {
	action: string
	tabId?: number
	frameId?: string | null
}

export type PopupResponse =
	| { success: true }
	| { success: true; tabs: PopupTabWithTargets[] }
	| { success: true; status: PopupStatusPayload }
	| { success: false; error: string }
