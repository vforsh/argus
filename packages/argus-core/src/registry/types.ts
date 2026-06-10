/** Target matching rules for CDP selection. */
export type WatcherMatch = {
	/** Substring match against the CDP target URL. */
	url?: string
	/** Substring match against the CDP target title. */
	title?: string
	/** JavaScript regex pattern (without flags) matched against the CDP target URL. */
	urlRegex?: string
	/** JavaScript regex pattern (without flags) matched against the CDP target title. */
	titleRegex?: string
	/**
	 * Filter by target type (e.g., 'page', 'iframe', 'worker').
	 * Exact match against the Chrome target `type` field.
	 */
	type?: string
	/**
	 * Match against URL origin only (protocol + host + port).
	 * Ignores path, query params, and hash. Useful for iframe matching
	 * when parent pages may include the iframe URL in query params.
	 */
	origin?: string
	/**
	 * Connect to a specific target by its Chrome target ID.
	 * Bypasses URL/title matching entirely. Get target IDs from `argus page targets`.
	 */
	targetId?: string
	/**
	 * Filter by parent target URL pattern.
	 * Only matches targets whose parent's URL includes this substring.
	 * Useful for targeting iframes within a specific parent page.
	 */
	parent?: string
}

/** Chrome CDP connection details. */
export type WatcherChrome = {
	/** Hostname / IP where Chrome's remote debugging endpoint is reachable. */
	host: string
	/** Port for Chrome's remote debugging endpoint (commonly `9222`). */
	port: number
}

/**
 * Source mode for a watcher's Chrome connection.
 * - `cdp`: Connect directly to Chrome via WebSocket.
 * - `extension`: Connect via the Argus Chrome extension (Native Messaging).
 */
export type WatcherSourceMode = 'cdp' | 'extension'

/**
 * Page console logging level for watcher lifecycle and request logs.
 * - `none`: Do not write anything to the page's DevTools console.
 * - `minimal`: Write attach/detach lifecycle messages.
 * - `full`: Same as minimal, plus log every HTTP request to the watcher API.
 */
export type PageConsoleLogging = 'none' | 'minimal' | 'full'

/** Registry entry for a watcher instance. */
export type WatcherRecord = {
	/** Unique watcher identifier (also used as the key in the registry). */
	id: string
	/** Host/interface the watcher HTTP server is bound to. */
	host: string
	/** Port the watcher HTTP server is bound to. */
	port: number
	/** Process ID of the watcher process. */
	pid: number
	/** Working directory (`process.cwd()`) of the watcher process. */
	cwd?: string
	/** Watcher start time as milliseconds since Unix epoch. */
	startedAt: number
	/** Last update time as milliseconds since Unix epoch. */
	updatedAt: number
	/** Optional CDP target matching rules used by this watcher. */
	match?: WatcherMatch
	/** Optional CDP connection details used by this watcher. */
	chrome?: WatcherChrome
	/** Whether to include ISO timestamps in formatted log output. */
	includeTimestamps?: boolean
	/** Source mode: 'cdp' (direct Chrome connection) or 'extension' (via Chrome extension). */
	source?: WatcherSourceMode
}

/** Registry schema v1. */
export type RegistryV1 = {
	/** Schema version discriminator. */
	version: 1
	/** Registry update time as milliseconds since Unix epoch. */
	updatedAt: number
	/** Watchers keyed by `WatcherRecord.id`. */
	watchers: Record<string, WatcherRecord>
}

/** Result of reading the registry file with warnings. */
export type RegistryReadResult = {
	/** Parsed registry content (normalized to the latest supported schema). */
	registry: RegistryV1
	/** Non-fatal warnings encountered while reading/parsing the registry file. */
	warnings: string[]
}
