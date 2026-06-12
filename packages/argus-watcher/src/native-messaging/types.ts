/**
 * Message types for Native Messaging communication between
 * the Chrome extension and argus-watcher (extension source).
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
	topFrameId?: string | null
	frames?: FrameSnapshot[]
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
	sessionId?: string
}

export type CdpResponseMessage = {
	type: 'cdp_response'
	requestId: number
	result?: unknown
	error?: { code?: number; message: string }
}

export type CookieQueryResponseMessage = {
	type: 'cookie_query_response'
	requestId: number
	cookies?: NativeCookie[]
	error?: { message: string }
}

export type ListTabsResponseMessage = {
	type: 'list_tabs_response'
	requestId: number
	tabs: TabInfo[]
}

export type TabActionResponseMessage = {
	type: 'tab_action_response'
	requestId: number
	ok: boolean
	tab?: TabInfo
	watcherId?: string
	error?: { message: string }
}

export type ControlStatusResponseMessage = {
	type: 'control_status_response'
	requestId: number
	diagnostics: ControlDiagnostics
}

export type TargetSelectedMessage = {
	type: 'target_selected'
	tabId: number
	frameId?: string | null
}

export type HostInfoMessage = {
	type: 'host_info'
	watcherId: string
	watcherHost: string
	watcherPort: number
	pid: number
}

export type HostReadyMessage = {
	type: 'host_ready'
}

export type TargetInfoMessage = {
	type: 'target_info'
	targetId: string
	title: string | null
	url: string | null
	attachedAt: number
	targetReady?: boolean | null
}

export type InitTabWatcherMessage = {
	type: 'init_tab_watcher'
	watcherId?: string
}

export type TabInfo = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	watcherId?: string
}

export type ControlDiagnostics = {
	extensionId: string | null
	extensionVersion: string | null
	control: {
		connected: boolean
		watcherId: string | null
		watcherHost: string | null
		watcherPort: number | null
		pid: number | null
		lastMessageAt: number | null
	}
	tabWatchers: Array<{
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
	}>
	recentEvents: Array<{
		ts: number
		level: 'info' | 'error'
		source: 'popup' | 'bridge' | 'debugger'
		message: string
	}>
}

export type FrameSnapshot = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
	sessionId: string | null
}

export type NativeCookie = {
	name: string
	value: string
	domain: string
	path: string
	secure: boolean
	httpOnly: boolean
	session: boolean
	expires: number | null
	sameSite: string | null
}

export type ExtensionToHost =
	| TabAttachedMessage
	| TabDetachedMessage
	| CdpEventMessage
	| CdpResponseMessage
	| CookieQueryResponseMessage
	| TargetSelectedMessage

export type ExtensionToControlHost = ListTabsResponseMessage | TabActionResponseMessage | ControlStatusResponseMessage

export type ExtensionToTabHost = ExtensionToHost | InitTabWatcherMessage

// ============================================================
// Host -> Extension messages
// ============================================================

export type AttachTabMessage = {
	type: 'attach_tab'
	tabId: number
}

export type AttachTabWatcherMessage = {
	type: 'attach_tab_watcher'
	requestId: number
	tabId: number
	watcherId?: string
}

export type DetachTabWatcherMessage = {
	type: 'detach_tab_watcher'
	requestId: number
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
	sessionId?: string
}

export type ListTabsMessage = {
	type: 'list_tabs'
	requestId: number
	filter?: {
		url?: string
		title?: string
	}
}

export type ControlStatusMessage = {
	type: 'control_status'
	requestId: number
}

export type EnableDomainMessage = {
	type: 'enable_domain'
	tabId: number
	domain: string
}

export type CookieQueryMessage = {
	type: 'cookie_query'
	requestId: number
	tabId: number
	domain?: string
	url?: string
}

export type HostToExtension =
	| AttachTabMessage
	| DetachTabMessage
	| CdpCommandMessage
	| CookieQueryMessage
	| EnableDomainMessage
	| HostInfoMessage
	| HostReadyMessage
	| TargetInfoMessage

export type ControlHostToExtension =
	| AttachTabWatcherMessage
	| DetachTabWatcherMessage
	| ListTabsMessage
	| ControlStatusMessage
	| HostInfoMessage
	| HostReadyMessage

export type TabHostToExtension = HostToExtension

// ============================================================
// CDP Session types
// ============================================================

export type PendingRequest = {
	requestId: number
	resolve: (result: unknown) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

export type CdpEventMeta = {
	sessionId?: string | null
}

export type CdpEventHandler = (params: unknown, meta: CdpEventMeta) => void
