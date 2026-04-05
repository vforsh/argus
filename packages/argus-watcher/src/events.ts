import type { LogLevel } from '@vforsh/argus-core'

/**
 * Event payload for when the watcher attaches to a CDP target.
 */
export type CdpAttachedEvent = {
	/** ISO timestamp of the event. */
	ts: number
	/** Unique watcher identifier. */
	watcherId: string
	/** CDP target metadata. */
	target: {
		/** Human-readable page title for the target. */
		title: string | null
		/** Page URL for the target. */
		url: string | null
		/** Target type (e.g., 'page', 'iframe', 'worker'). */
		type: string | null
		/** Parent target ID for nested targets (e.g., iframes). Null for top-level pages. */
		parentId: string | null
	} | null
}

/**
 * Event payload for when the watcher detaches from a CDP target.
 */
export type CdpDetachedEvent = {
	/** ISO timestamp of the event. */
	ts: number
	/** Unique watcher identifier. */
	watcherId: string
	/** Best-effort reason for detachment. */
	reason: string
	/** Last known CDP target metadata. */
	target: {
		/** Human-readable page title for the target. */
		title: string | null
		/** Page URL for the target. */
		url: string | null
	} | null
}

/**
 * Query parameters for log/tail requests.
 */
export type LogRequestQuery = {
	after?: number
	limit?: number
	levels?: LogLevel[]
	match?: string[]
	matchCase?: 'sensitive' | 'insensitive'
	source?: string
	sinceTs?: number
	timeoutMs?: number
}

/**
 * Query parameters for network/tail requests.
 */
export type NetRequestQuery = {
	id?: number
	requestId?: string
	after?: number
	limit?: number
	sinceTs?: number
	timeoutMs?: number
	grep?: string
	ignoreHosts?: string[]
	ignorePatterns?: string[]
	origin?: string
	domain?: string
	includeValues?: boolean
}

/**
 * Event payload for when a client requests logs or tail via HTTP.
 */
export type HttpRequestEvent = {
	/** ISO timestamp of the event. */
	ts: number
	/** Unique watcher identifier. */
	watcherId: string
	/** The requested endpoint. */
	endpoint:
		| 'logs'
		| 'tail'
		| 'net'
		| 'net/request'
		| 'net/tail'
		| 'net/clear'
		| 'auth/cookies'
		| 'auth/cookies/get'
		| 'auth/cookies/set'
		| 'auth/cookies/delete'
		| 'auth/cookies/clear'
		| 'auth/state'
		| 'auth/state/load'
		| 'eval'
		| 'trace/start'
		| 'trace/stop'
		| 'screenshot'
		| 'snapshot'
		| 'locate/role'
		| 'locate/text'
		| 'locate/label'
		| 'code/list'
		| 'code/read'
		| 'code/grep'
		| 'dom/tree'
		| 'dom/info'
		| 'dom/hover'
		| 'dom/click'
		| 'dom/keydown'
		| 'dom/add'
		| 'dom/remove'
		| 'dom/modify'
		| 'dom/set-file'
		| 'dom/focus'
		| 'dom/fill'
		| 'dom/scroll'
		| 'dom/scroll-to'
		| 'emulation'
		| 'throttle'
		| 'dialog/status'
		| 'dialog/handle'
		| 'storage/local'
		| 'storage/session'
		| 'reload'
		| 'shutdown'
		| 'targets'
		| 'attach'
		| 'detach'
	/** IP address of the requester (best-effort). */
	remoteAddress: string | null
	/** Parsed query parameters. */
	query?: LogRequestQuery | NetRequestQuery
}

/**
 * Map of events emitted by the Argus watcher.
 */
export type ArgusWatcherEventMap = {
	cdpAttached: CdpAttachedEvent
	cdpDetached: CdpDetachedEvent
	httpRequested: HttpRequestEvent
}
