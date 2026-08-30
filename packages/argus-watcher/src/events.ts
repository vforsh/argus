import type { WatcherEndpoint, WatcherRequestQuery } from './http/endpoints.js'

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
 * Event payload for when a client requests logs or tail via HTTP.
 */
export type HttpRequestEvent = {
	/** ISO timestamp of the event. */
	ts: number
	/** Unique watcher identifier. */
	watcherId: string
	/** The requested endpoint. */
	endpoint: WatcherEndpoint
	/** IP address of the requester (best-effort). */
	remoteAddress: string | null
	/** Parsed query parameters. */
	query?: WatcherRequestQuery
}

/**
 * Map of events emitted by the Argus watcher.
 */
export type ArgusWatcherEventMap = {
	cdpAttached: CdpAttachedEvent
	cdpDetached: CdpDetachedEvent
	httpRequested: HttpRequestEvent
}
