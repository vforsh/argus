import type { LogEvent, LogLevel, StatusResponse, WatcherRecord } from '@vforsh/argus-core'

/** Options for configuring the Argus client. */
export type ArgusClientOptions = {
	/** Override registry path instead of using `ARGUS_REGISTRY_PATH` / default. */
	registryPath?: string
	/** TTL used for pruning stale watchers before list/logs. Default: `DEFAULT_TTL_MS`. */
	ttlMs?: number
	/** Default HTTP timeout (ms). */
	timeoutMs?: number
}

/** Options for listing watchers from the registry. */
export type ListOptions = {
	/** Filter watchers by cwd substring, like CLI. */
	byCwd?: string
}

/** Result entry for a single watcher in list results. */
export type ListResult = {
	/** The watcher record as stored in the registry. */
	watcher: WatcherRecord
	/** Whether we could reach `GET /status`. */
	reachable: boolean
	/** Status response when reachable. */
	status?: StatusResponse
	/** Error message when unreachable. */
	error?: string
}

/** Controls how log event args are returned. */
export type LogsMode = 'preview' | 'full'

/** Options for fetching logs from a watcher. */
export type LogsOptions = {
	mode?: LogsMode
	levels?: string | LogLevel[]
	/** Regex match patterns (repeatable). */
	match?: string | string[]
	/** Regex case handling for `match` patterns. */
	matchCase?: 'sensitive' | 'insensitive'
	/** Filter by log event source substring. */
	source?: string
	after?: number
	limit?: number
	/**
	 * Filter by time window.
	 * - If string: parsed like CLI (e.g. "10m", "2h")
	 * - If number: treated as durationMs
	 */
	since?: string | number
}

/** Logs response data with pagination cursor. */
export type LogsResult = {
	events: LogEvent[]
	nextAfter: number
}

/** Argus client API. */
export type ArgusClient = {
	list: (options?: ListOptions) => Promise<ListResult[]>
	logs: (watcherId: string, options?: LogsOptions) => Promise<LogsResult>
}
