/**
 * Native Messaging wire protocol shared by the Chrome extension and argus-watcher.
 *
 * This module is the single definition of the extension <-> watcher contract. The two
 * peers ship as independently versioned npm packages, so a field added on one side and
 * forgotten on the other would compile cleanly and only fail at runtime in a user's
 * Chrome — importing both ends from here makes that a compile error instead.
 *
 * The extension bundles this with esbuild: keep it types plus erasable constants only,
 * so the extension's no-runtime-dependencies property survives.
 */

/**
 * Version of the native-messaging wire contract.
 *
 * Bump on any breaking change to the message shapes below. Peers exchange it in the
 * `host_info` handshake and refuse to proceed on a mismatch.
 */
export const NATIVE_MESSAGING_PROTOCOL_VERSION = 2 as const

/** Type-level alias for the current native-messaging protocol version. */
export type NativeMessagingProtocolVersion = typeof NATIVE_MESSAGING_PROTOCOL_VERSION

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

/** Why the extension published a frame snapshot; informational (diagnostics/logs only). */
export type FrameSnapshotReason = 'navigation_resync' | 'child_attached' | 'child_detached' | 'requested'

/**
 * Authoritative frame table for one attached tab, pushed by the extension whenever its
 * table changes and returned in response to {@link FrameSnapshotRequestMessage}.
 *
 * `frames` is always the FULL table for the tab (never a delta) so applying a snapshot is
 * idempotent: the watcher replaces its copy wholesale instead of replaying synthetic
 * `Page.frameNavigated`/`Page.frameDetached` events. Real CDP events still flow as
 * `cdp_event` and remain the immediate-reaction channel; snapshots are the reconciliation.
 */
export type FrameSnapshotMessage = {
	type: 'frame_snapshot'
	tabId: number
	topFrameId: string | null
	frames: FrameSnapshot[]
	reason: FrameSnapshotReason
	/** Present when this snapshot answers a `frame_snapshot_request`; absent on pushes. */
	requestId?: number
}

/**
 * Host -> extension pull for the current frame table (bootstrap and target recovery).
 * With `refresh: true` the extension re-reads `Page.getFrameTree` for the root and every
 * child session before answering, so the reply reflects Chrome, not just cached state.
 */
export type FrameSnapshotRequestMessage = {
	type: 'frame_snapshot_request'
	requestId: number
	tabId: number
	refresh?: boolean
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

/**
 * Outcome of a control-host tab action, as both peers model it in memory.
 *
 * This is the discriminated form of {@link TabActionResponseMessage}, whose `ok`/`tab`/
 * `error` fields are independently optional on the wire. Producers build this and
 * serialize it; consumers reconstruct it on receipt.
 */
export type TabActionResult = { ok: true; tab: TabInfo; watcherId?: string } | { ok: false; error: string }

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
	/**
	 * Native-messaging protocol version the host was built against.
	 *
	 * Absent when an older watcher predates the handshake — treat that as an
	 * unknown, incompatible version rather than as a match.
	 */
	protocolVersion?: NativeMessagingProtocolVersion
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

/** Runtime state of the extension-level control bridge. */
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

/**
 * Diagnostics snapshot the extension reports over the control bridge.
 *
 * `GET /extension/diagnostics` reshapes this into {@link ExtensionDiagnosticsResponse};
 * both use the same member types so a diagnostics change lands in one place.
 */
export type ControlDiagnostics = {
	extensionId: string | null
	extensionVersion: string | null
	control: ExtensionControlBridgeStatus
	tabWatchers: ExtensionTabBridgeStatus[]
	recentEvents: ExtensionRecentEvent[]
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
	| FrameSnapshotMessage

export type ExtensionToControlHost = ListTabsResponseMessage | TabActionResponseMessage | ControlStatusResponseMessage

export type ExtensionToTabHost = ExtensionToHost | InitTabWatcherMessage

// ============================================================
// Host -> Extension messages
// ============================================================

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

export type CookieQueryMessage = {
	type: 'cookie_query'
	requestId: number
	tabId: number
	domain?: string
	url?: string
}

export type HostToExtension =
	| DetachTabMessage
	| CdpCommandMessage
	| CookieQueryMessage
	| FrameSnapshotRequestMessage
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
