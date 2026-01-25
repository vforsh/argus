/**
 * Native Messaging protocol types for communication between
 * the Chrome extension and the argus-watcher (extension mode).
 */

// ============================================================
// Extension -> Host messages
// ============================================================

export type TabAttachedMessage = {
	type: 'tab_attached'
	tabId: number
	url: string
	title: string
	faviconUrl?: string
}

export type TabDetachedMessage = {
	type: 'tab_detached'
	tabId: number
	reason: string
}

export type CdpEventMessage = {
	type: 'cdp_event'
	tabId: number
	method: string
	params: unknown
}

export type CdpResponseMessage = {
	type: 'cdp_response'
	requestId: number
	result?: unknown
	error?: { code?: number; message: string }
}

export type ListTabsResponseMessage = {
	type: 'list_tabs_response'
	tabs: TabInfo[]
}

export type TabInfo = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
}

export type ExtensionToHost = TabAttachedMessage | TabDetachedMessage | CdpEventMessage | CdpResponseMessage | ListTabsResponseMessage

// ============================================================
// Host -> Extension messages
// ============================================================

export type AttachTabMessage = {
	type: 'attach_tab'
	tabId: number
}

export type DetachTabMessage = {
	type: 'detach_tab'
	tabId: number
}

export type CdpCommandMessage = {
	type: 'cdp_command'
	requestId: number
	tabId: number
	method: string
	params?: Record<string, unknown>
}

export type ListTabsMessage = {
	type: 'list_tabs'
	filter?: {
		url?: string
		title?: string
	}
}

export type EnableDomainMessage = {
	type: 'enable_domain'
	tabId: number
	domain: string
}

export type HostToExtension = AttachTabMessage | DetachTabMessage | CdpCommandMessage | ListTabsMessage | EnableDomainMessage
