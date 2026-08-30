import type {
	DomClickRequest,
	DomClickResponse,
	EvalRequest,
	EvalResponse,
	LogEvent,
	LogEpoch,
	LogLevel,
	NetClearResponse,
	NetResponse,
	NetworkRequestDetail,
	RecordRequest,
	RecordStartRequest,
	RecordStartResponse,
	RecordStopRequest,
	RecordStopResponse,
	ReloadRequest,
	ResponseData,
	ScreenshotRequest,
	ScreenshotResponse,
	StatusResponse,
	TraceStartRequest,
	TraceStartResponse,
	TraceStopRequest,
	TraceStopResponse,
	VisibilityRequest,
	VisibilityResponse,
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
	/** Opaque cursor returned by `beginLogEpoch` / `logCursor`. */
	after?: LogEpoch
	/** Read only events produced after this opaque watcher-session marker. */
	sinceEpoch?: LogEpoch
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
	nextCursor: LogEpoch
}

/** Current watcher log cursor, suitable as a zero-download baseline. */
export type LogCursorResult = {
	cursor: LogEpoch
}

/** Opaque watcher-session marker suitable for action-scoped log queries. */
export type LogEpochResult = {
	epoch: LogEpoch
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
	/** Ignore requests by host name (exact host or subdomain match). */
	ignoreHost?: string[]
	/** Ignore requests whose URL contains one of these substrings. */
	ignorePattern?: string[]
}

/** Network request summary results with pagination cursor. */
export type NetResult = ResponseData<NetResponse>

/**
 * Options for evaluating a JS expression in the connected page.
 *
 * This *is* the POST /eval body — it is sent verbatim — so it aliases the protocol
 * request type rather than restating it.
 */
export type EvalOptions = EvalRequest

/** Result of a remote evaluation. */
export type EvalResult = ResponseData<EvalResponse>

/** Options for starting a Chrome trace. */
export type TraceStartOptions = TraceStartRequest

/** Trace start result metadata. */
export type TraceStartResult = ResponseData<TraceStartResponse>

/** Options for stopping an active trace. */
export type TraceStopOptions = TraceStopRequest

/** Trace stop result metadata. */
export type TraceStopResult = ResponseData<TraceStopResponse>

/** Options for capturing a screenshot. */
export type ScreenshotOptions = ScreenshotRequest

/** Screenshot result metadata. */
export type ScreenshotResult = ResponseData<ScreenshotResponse>

/** Options for clicking in the connected page. Mirrors CLI `argus click` semantics. */
export type DomClickOptions = DomClickRequest

/** Result of a click, reporting selector matches separately from actual clicks. */
export type DomClickResult = ResponseData<DomClickResponse>

/** Result of clearing the watcher's buffered network log. */
export type NetClearResult = ResponseData<NetClearResponse>

/** Options for the page visibility lock. */
export type VisibilityOptions = VisibilityRequest

/**
 * Visibility lock result. The desired lock is sticky across detach/reattach:
 * the watcher remembers it and re-applies on the next attach when `attached` is false.
 */
export type VisibilityResult = ResponseData<VisibilityResponse>

/** Options for reloading the connected page. */
export type ReloadOptions = ReloadRequest

/** Shared options for video recording requests. */
export type RecordOptions = RecordStartRequest

/** Options for a fixed-duration one-shot recording. */
export type RecordCaptureOptions = RecordRequest

/** Metadata returned when a recording starts. */
export type RecordStartResult = ResponseData<RecordStartResponse>

/** Metadata returned when a recording is finalized. */
export type RecordStopResult = ResponseData<RecordStopResponse>

/** Options for stopping an active recording. */
export type RecordStopOptions = RecordStopRequest

/**
 * Options for {@link ArgusClient.evalValue}.
 *
 * Omits `returnByValue` (always true) and adds {@link EvalValueOptions.jsonValue}.
 */
export type EvalValueOptions = Omit<EvalOptions, 'expression' | 'returnByValue' | 'jsonValue'> & {
	/**
	 * Have the page serialize the result, so the JSON string — not a structured object —
	 * crosses the transport. Defaults to true.
	 *
	 * This exists because transports disagree about raw `returnByValue` results: the
	 * extension relay (Chrome's `chrome.debugger` serialization) returns object keys
	 * sorted alphabetically at every nesting level, while a direct CDP watcher preserves
	 * insertion order. Values are identical either way, but structural comparisons of the
	 * same page state produce different bytes per transport — which silently breaks
	 * snapshot assertions in verification runners. Serializing in the page normalizes both
	 * to insertion order, and makes `Date` round-trip as an ISO string (via `toJSON`)
	 * instead of `{}`.
	 *
	 * Evaluation semantics are unaffected: statement lists, top-level `await`, REPL-mode
	 * redeclaration, and promise unwrapping behave the same either way.
	 *
	 * Set to false for the raw transport-native value — one less serialization round-trip
	 * for large payloads you never compare structurally, at the cost of transport-dependent
	 * key order.
	 */
	jsonValue?: boolean
}

/** Options for {@link ArgusClient.evalUntil}. */
export type EvalUntilOptions = EvalValueOptions & {
	/** Delay between polls in milliseconds. Defaults to 250. */
	intervalMs?: number
	/** Give up after this much wall-clock time. Defaults to 30000. */
	totalTimeoutMs?: number
	/** Give up after this many polls. Unlimited when omitted. */
	count?: number
	/**
	 * Stop condition evaluated against each poll's value.
	 * Defaults to a truthiness check on the returned value.
	 */
	predicate?: (value: unknown, iteration: number) => boolean
	/** Abort the poll loop early. The returned promise rejects when aborted. */
	signal?: AbortSignal
}

/** Result of a successful {@link ArgusClient.evalUntil} poll. */
export type EvalUntilResult = {
	/** The value that satisfied the predicate. */
	value: unknown
	/** 1-based poll iteration that matched. */
	iteration: number
	/** Wall-clock milliseconds spent polling. */
	elapsedMs: number
}

/** Argus client API. */
export type ArgusClient = {
	/** List registered watcher servers. */
	list: (options?: ListOptions) => Promise<ListResult[]>
	/** Fetch log events from a watcher. */
	logs: (watcherId: string, options?: LogsOptions) => Promise<LogsResult>
	/** Read the current log cursor without fetching buffered events. */
	logCursor: (watcherId: string) => Promise<LogCursorResult>
	/** Begin an action-scoped log epoch without downloading buffered events. */
	beginLogEpoch: (watcherId: string) => Promise<LogEpochResult>
	/** Fetch network request summaries from a watcher. */
	net: (watcherId: string, options?: NetOptions) => Promise<NetResult>
	/** Fetch the detailed record for one buffered network request. */
	netRequest: (watcherId: string, request: number | string) => Promise<NetworkRequestDetail>
	/** Clear the watcher's buffered network log. */
	netClear: (watcherId: string) => Promise<NetClearResult>
	/**
	 * Evaluate a JS expression in the connected page and return the raw envelope.
	 * Page-side exceptions are reported in `exception`, not thrown.
	 */
	eval: (watcherId: string, options: EvalOptions) => Promise<EvalResult>
	/**
	 * Evaluate a JS expression and return its value directly.
	 *
	 * Unlike {@link ArgusClient.eval}, a page-side exception rejects with an `Error`
	 * carrying `exception.text` as its message. Results are normalized across transports
	 * by default — see {@link EvalValueOptions.jsonValue}.
	 *
	 * @throws {Error} When the expression throws in the page.
	 */
	evalValue: <T = unknown>(watcherId: string, expression: string, options?: EvalValueOptions) => Promise<T>
	/**
	 * Poll an expression until it satisfies a predicate (truthy by default).
	 *
	 * @throws {Error} On page-side exceptions, total-timeout expiry, poll-count
	 * exhaustion, or abort via {@link EvalUntilOptions.signal}.
	 */
	evalUntil: (watcherId: string, expression: string, options?: EvalUntilOptions) => Promise<EvalUntilResult>
	/** Click in the connected page by selector, element ref, or viewport coordinates. */
	domClick: (watcherId: string, options: DomClickOptions) => Promise<DomClickResult>
	/** Lock the page shown+focused, or release the lock. */
	visibility: (watcherId: string, options: VisibilityOptions) => Promise<VisibilityResult>
	/** Reload the connected page. Page-scoped even when the active target is an iframe. */
	reload: (watcherId: string, options?: ReloadOptions) => Promise<void>
	/** Start Chrome tracing and write to disk on the watcher. */
	traceStart: (watcherId: string, options?: TraceStartOptions) => Promise<TraceStartResult>
	/** Stop an active Chrome trace and finalize the file. */
	traceStop: (watcherId: string, options?: TraceStopOptions) => Promise<TraceStopResult>
	/** Capture a screenshot and write to disk on the watcher. */
	screenshot: (watcherId: string, options?: ScreenshotOptions) => Promise<ScreenshotResult>
	/** Capture a fixed-duration silent video and write it to disk on the watcher. */
	record: (watcherId: string, options: RecordCaptureOptions) => Promise<RecordStopResult>
	/** Begin an open-ended silent video recording. Finalize with `recordStop`. */
	recordStart: (watcherId: string, options?: RecordOptions) => Promise<RecordStartResult>
	/** Stop the active recording and finalize the file. */
	recordStop: (watcherId: string, options?: RecordStopOptions) => Promise<RecordStopResult>
	/** Bind every watcher-scoped method to `watcherId`, removing id-threading at call sites. */
	watcher: (watcherId: string) => WatcherClient
}

/**
 * Watcher-scoped subset of {@link ArgusClient}: everything that takes a watcher id first.
 * `evalValue` is excluded because a mapped type erases its generic type parameter;
 * {@link WatcherClient} redeclares it explicitly.
 */
type WatcherScopedApi = Omit<ArgusClient, 'list' | 'watcher' | 'evalValue'>

/**
 * The same API as {@link ArgusClient} with `watcherId` pre-bound.
 *
 * @example
 * const page = client.watcher('playground')
 * const count = await page.evalValue<number>('document.querySelectorAll("li").length')
 */
export type WatcherClient = {
	[K in keyof WatcherScopedApi]: WatcherScopedApi[K] extends (watcherId: string, ...rest: infer A) => infer R ? (...args: A) => R : never
} & {
	/**
	 * Evaluate a JS expression and return its value directly.
	 *
	 * @throws {Error} When the expression throws in the page.
	 */
	evalValue: <T = unknown>(expression: string, options?: EvalValueOptions) => Promise<T>
}
