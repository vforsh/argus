import type {
	LogEvent,
	LogLevel,
	NetworkRequestSummary,
	StatusResponse,
	WatcherRecord,
} from '@vforsh/argus-core'

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

/** Options for fetching network request summaries. */
export type NetOptions = {
	after?: number
	limit?: number
	/**
	 * Filter by time window.
	 * - If string: parsed like CLI (e.g. "10m", "2h")
	 * - If number: treated as durationMs
	 */
	since?: string | number
	/** Substring match over redacted URLs. */
	grep?: string
}

/** Network request summary results with pagination cursor. */
export type NetResult = {
	requests: NetworkRequestSummary[]
	nextAfter: number
}

/** Options for evaluating a JS expression in the connected page. */
export type EvalOptions = {
	/** JS expression to execute. */
	expression: string
	/** Await promises before returning. Defaults to true. */
	awaitPromise?: boolean
	/** Command timeout in milliseconds. */
	timeoutMs?: number
	/** Return by value when possible. Defaults to true. */
	returnByValue?: boolean
}

/** Result of a remote evaluation. */
export type EvalResult = {
	result: unknown
	type: string | null
	exception: { text: string; details?: unknown } | null
}

/** Options for starting a Chrome trace. */
export type TraceStartOptions = {
	outFile?: string
	categories?: string
	options?: string
}

/** Trace start result metadata. */
export type TraceStartResult = {
	traceId: string
	outFile: string
}

/** Options for stopping an active trace. */
export type TraceStopOptions = {
	traceId?: string
}

/** Trace stop result metadata. */
export type TraceStopResult = {
	outFile: string
}

/** Options for capturing a screenshot. */
export type ScreenshotOptions = {
	outFile?: string
	selector?: string
	format?: 'png'
}

/** Screenshot result metadata. */
export type ScreenshotResult = {
	outFile: string
	clipped: boolean
}

/** Argus client API. */
export type ArgusClient = {
	/** List registered watcher servers. */
	list: (options?: ListOptions) => Promise<ListResult[]>
	/** Fetch log events from a watcher. */
	logs: (watcherId: string, options?: LogsOptions) => Promise<LogsResult>
	/** Fetch network request summaries from a watcher. */
	net: (watcherId: string, options?: NetOptions) => Promise<NetResult>
	/** Evaluate a JS expression in the connected page. */
	eval: (watcherId: string, options: EvalOptions) => Promise<EvalResult>
	/** Start Chrome tracing and write to disk on the watcher. */
	traceStart: (watcherId: string, options?: TraceStartOptions) => Promise<TraceStartResult>
	/** Stop an active Chrome trace and finalize the file. */
	traceStop: (watcherId: string, options?: TraceStopOptions) => Promise<TraceStopResult>
	/** Capture a screenshot and write to disk on the watcher. */
	screenshot: (watcherId: string, options?: ScreenshotOptions) => Promise<ScreenshotResult>
}
