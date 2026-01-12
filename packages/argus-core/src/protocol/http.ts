import type { LogEvent } from './logs.js'
import type { WatcherRecord } from '../registry/types.js'

/** Response payload for GET /status. */
export type StatusResponse = {
	ok: true
	id: string
	pid: number
	attached: boolean
	target: {
		title: string | null
		url: string | null
	} | null
	buffer: {
		size: number
		count: number
		minId: number | null
		maxId: number | null
	}
	watcher: WatcherRecord
}

/** Response payload for GET /logs. */
export type LogsResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
}

/** Response payload for GET /tail. */
export type TailResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
	timedOut: boolean
}

/** Network request summary captured from CDP. */
export type NetworkRequestSummary = {
	id: number
	ts: number
	requestId: string
	url: string
	method: string
	resourceType: string | null
	status: number | null
	encodedDataLength: number | null
	errorText: string | null
	durationMs: number | null
	// later: add redacted request/response headers behind a flag.
}

/** Response payload for GET /net. */
export type NetResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
}

/** Response payload for GET /net/tail. */
export type NetTailResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
	timedOut: boolean
}

/** Request payload for POST /eval. */
export type EvalRequest = {
	expression: string
	awaitPromise?: boolean
	timeoutMs?: number
	returnByValue?: boolean
}

/** Response payload for POST /eval. */
export type EvalResponse = {
	ok: true
	result: unknown
	type: string | null
	exception: { text: string; details?: unknown } | null
}

/** Request payload for POST /trace/start. */
export type TraceStartRequest = {
	outFile?: string
	categories?: string
	options?: string
}

/** Response payload for POST /trace/start. */
export type TraceStartResponse = {
	ok: true
	traceId: string
	outFile: string
}

/** Request payload for POST /trace/stop. */
export type TraceStopRequest = {
	traceId?: string
}

/** Response payload for POST /trace/stop. */
export type TraceStopResponse = {
	ok: true
	outFile: string
}

/** Request payload for POST /screenshot. */
export type ScreenshotRequest = {
	outFile?: string
	selector?: string
	format?: 'png'
}

/** Response payload for POST /screenshot. */
export type ScreenshotResponse = {
	ok: true
	outFile: string
	clipped: boolean
}

/** Standard error payload for API failures. */
export type ErrorResponse = {
	ok: false
	error: {
		message: string
		code?: string
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM inspection types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node in the DOM element tree.
 * Only contains element nodes (nodeType === 1); text/comment nodes are filtered out.
 */
export type DomNode = {
	/** CDP node ID. */
	nodeId: number
	/** Lowercased tag name (e.g. "div", "span"). */
	tag: string
	/** Attribute key-value pairs. */
	attributes: Record<string, string>
	/** Child element nodes. Omitted or empty if no children or truncated. */
	children?: DomNode[]
	/** True if children were omitted due to depth/maxNodes limits. */
	truncated?: boolean
}

/**
 * Detailed info about a single DOM element.
 */
export type DomElementInfo = {
	/** CDP node ID. */
	nodeId: number
	/** Lowercased tag name. */
	tag: string
	/** Attribute key-value pairs. */
	attributes: Record<string, string>
	/** Number of direct child element nodes. */
	childElementCount: number
	/** Element's outerHTML (may be truncated or null on error). */
	outerHTML: string | null
	/** True if outerHTML was truncated due to size limits. */
	outerHTMLTruncated: boolean
}

/**
 * Request payload for POST /dom/tree.
 */
export type DomTreeRequest = {
	/** CSS selector to match element(s). */
	selector: string
	/** Max depth to traverse (0 = root only). Default: 2. */
	depth?: number
	/** Max total nodes to return. Default: 5000. */
	maxNodes?: number
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
}

/**
 * Response payload for POST /dom/tree.
 */
export type DomTreeResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Subtree roots (one per match). Empty if no matches. */
	roots: DomNode[]
	/** True if output was truncated due to maxNodes or depth. */
	truncated: boolean
	/** Reason for truncation if truncated is true. */
	truncatedReason?: 'max_nodes' | 'depth'
}

/**
 * Request payload for POST /dom/info.
 */
export type DomInfoRequest = {
	/** CSS selector to match element(s). */
	selector: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Max characters for outerHTML. Default: 50000. */
	outerHtmlMaxChars?: number
}

/**
 * Response payload for POST /dom/info.
 */
export type DomInfoResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Element info (one per match). Empty if no matches. */
	elements: DomElementInfo[]
}
