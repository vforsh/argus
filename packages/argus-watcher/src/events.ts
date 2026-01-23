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
	after?: number
	limit?: number
	sinceTs?: number
	timeoutMs?: number
	grep?: string
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
		| 'net/tail'
		| 'eval'
		| 'trace/start'
		| 'trace/stop'
		| 'screenshot'
		| 'dom/tree'
		| 'dom/info'
		| 'dom/hover'
		| 'dom/click'
		| 'storage/local'
		| 'shutdown'
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
