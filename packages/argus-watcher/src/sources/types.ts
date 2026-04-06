/**
 * Source abstraction types for unified CDP and Extension modes.
 * Both sources implement the same interface, allowing the watcher
 * to work with either CDP WebSocket or Extension Native Messaging.
 */

import type { AuthStateCookie, LogEvent } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import type { NetFilterContext } from '../net/filtering.js'

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

/** Browser-cookie query used by auth-state export to capture same-site auth outside the active page host. */
export type CdpSourceCookieQuery = {
	/** Best-effort site-domain filter (for example `stark.games`). Null means "no domain filter". */
	domain?: string | null
	/** Current page URL for source-specific cookie-store selection. */
	url?: string | null
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
	/** Called when the attached source switches between page/frame targets without detaching. */
	onTargetChanged?: (session: CdpSessionHandle, target: CdpSourceTarget) => void
}

/**
 * Handle for a running CDP source.
 */
export type CdpSourceHandle = {
	/** The CDP session handle for sending commands and subscribing to events. */
	session: CdpSessionHandle
	/** The raw top-level page session handle, for page-scoped operations like indicators. */
	pageSession?: CdpSessionHandle
	/** Sync watcher metadata after the HTTP server has its final host/port (extension mode only). */
	syncWatcherInfo?: (info: { watcherId: string; watcherHost: string; watcherPort: number; watcherPid: number }) => void
	/** Read browser-level cookies for the attached session's site, when the source can do better than page-scoped CDP. */
	readBrowserCookies?: (query: CdpSourceCookieQuery) => Promise<AuthStateCookie[]>
	/** Best-effort target metadata used to resolve network filter scope in HTTP routes. */
	getNetFilterContext?: () => NetFilterContext | null
	/** Resolve the child CDP session that owns a given frame (extension mode only). */
	getFrameSessionId?: (frameId: string) => string | null
	/** Stop the source and clean up resources. */
	stop: () => Promise<void>
	/** List available targets (extension mode only). */
	listTargets?: () => Promise<CdpSourceTarget[]>
	/** Attach to a specific target by ID (extension mode only). */
	attachTarget?: (targetId: string) => void
	/** Detach from a specific target by ID (extension mode only). */
	detachTarget?: (targetId: string) => void
}

/**
 * Options common to all CDP sources.
 */
export type CdpSourceBaseOptions = {
	/** Event handlers for the source. */
	events: CdpSourceEvents
	/** Watcher id for source-specific metadata/events. */
	watcherId?: string
	/** Watcher HTTP host for source-specific metadata/events. */
	watcherHost?: string
	/** Watcher HTTP port for source-specific metadata/events. */
	watcherPort?: number
	/** Optional ignore list filtering for log/exception locations. */
	ignoreMatcher?: ((url: string) => boolean) | null
	/** Strip these literal prefixes from event.file for display/logging. */
	stripUrlPrefixes?: string[]
}
