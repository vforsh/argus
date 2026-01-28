/**
 * Source abstraction types for unified CDP and Extension modes.
 * Both sources implement the same interface, allowing the watcher
 * to work with either CDP WebSocket or Extension Native Messaging.
 */

import type { LogEvent } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'

/**
 * Represents a CDP target (either from Chrome /json or extension tabs).
 */
export type CdpSourceTarget = {
	/** Target/tab ID (string for CDP, number for extension). */
	id: string
	/** Page title. */
	title: string
	/** Page URL. */
	url: string
	/** Target type (e.g., 'page', 'iframe'). */
	type?: string
	/** Parent target ID for nested targets. */
	parentId?: string | null
	/** Favicon URL (extension mode only). */
	faviconUrl?: string
	/** Whether the target is currently attached. */
	attached?: boolean
}

/**
 * CDP attachment status.
 */
export type CdpSourceStatus = {
	attached: boolean
	target: {
		title: string | null
		url: string | null
		type: string | null
		parentId: string | null
	} | null
	/** Best-effort reason for detachment. Null when attached. */
	reason?: string | null
}

/**
 * Events emitted by a CDP source.
 */
export type CdpSourceEvents = {
	/** Called when a log event is captured. */
	onLog: (event: Omit<LogEvent, 'id'>) => void
	/** Called when CDP status changes (attached/detached). */
	onStatus: (status: CdpSourceStatus) => void
	/** Called when a session is attached to a target. */
	onAttach?: (session: CdpSessionHandle, target: CdpSourceTarget) => Promise<void> | void
	/** Called when a session is detached from a target. */
	onDetach?: (reason: string) => void
	/** Called on page navigation (for file log rotation). */
	onPageNavigation?: (info: { url: string; title: string | null }) => void
	/** Called when the page DOM is ready after navigation. */
	onPageLoad?: () => void
	/** Called when page intl info is available. */
	onPageIntl?: (info: { timezone: string | null; locale: string | null }) => void
}

/**
 * Handle for a running CDP source.
 */
export type CdpSourceHandle = {
	/** The CDP session handle for sending commands and subscribing to events. */
	session: CdpSessionHandle
	/** Stop the source and clean up resources. */
	stop: () => Promise<void>
	/** List available targets (extension mode only). */
	listTargets?: () => Promise<CdpSourceTarget[]>
	/** Attach to a specific target by ID (extension mode only). */
	attachTarget?: (targetId: number) => void
	/** Detach from a specific target by ID (extension mode only). */
	detachTarget?: (targetId: number) => void
}

/**
 * Options common to all CDP sources.
 */
export type CdpSourceBaseOptions = {
	/** Event handlers for the source. */
	events: CdpSourceEvents
	/** Optional ignore list filtering for log/exception locations. */
	ignoreMatcher?: ((url: string) => boolean) | null
	/** Strip these literal prefixes from event.file for display/logging. */
	stripUrlPrefixes?: string[]
}
