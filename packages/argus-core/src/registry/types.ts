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

/**
 * Native Messaging role of an extension-backed watcher.
 * - `control`: one per browser instance; lists tabs and brokers attach/detach.
 * - `tab`: bound to exactly one browser tab.
 */
export type WatcherExtensionRole = 'control' | 'tab'

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
	/** Extension role, set when `source` is `extension`. Absent on records written by older hosts. */
	extensionRole?: WatcherExtensionRole
	/**
	 * Random per-run token identifying the process that owns this record.
	 *
	 * Only the owner refreshes or removes its record, so two processes that ever race for one id
	 * can't overwrite or delete each other's entry. Absent on records written by older hosts
	 * (treated as legacy: they still overwrite blindly).
	 */
	ownerId?: string
}

/**
 * Claim on a watcher id taken before the watcher's record can be published.
 *
 * A watcher needs its id before its HTTP port is known, so allocation writes a reservation in the
 * same locked update that picks the id. Allocators treat a live reservation as taken; readers that
 * resolve watchers never see it because reservations live outside `watchers`.
 */
export type WatcherReservation = {
	/** Reserved watcher id. */
	id: string
	/** Process holding the reservation; a dead PID frees it. */
	pid: number
	/** Owner token of the reserving run; matches the record it later publishes. */
	ownerId: string
	/** Reservation time as milliseconds since Unix epoch; expires after the registry TTL. */
	reservedAt: number
}

/** Registry schema v1. */
export type RegistryV1 = {
	/** Schema version discriminator. */
	version: 1
	/** Registry update time as milliseconds since Unix epoch. */
	updatedAt: number
	/** Watchers keyed by `WatcherRecord.id`. */
	watchers: Record<string, WatcherRecord>
	/** Ids reserved by watchers that are still starting, keyed by id. Optional for older registries. */
	reservations?: Record<string, WatcherReservation>
}

/** Result of reading the registry file with warnings. */
export type RegistryReadResult = {
	/** Parsed registry content (normalized to the latest supported schema). */
	registry: RegistryV1
	/** Non-fatal warnings encountered while reading/parsing the registry file. */
	warnings: string[]
}
