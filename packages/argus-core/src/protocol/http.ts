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

/** Response payload for POST /shutdown. */
export type ShutdownResponse = {
	ok: true
}

/** Request payload for POST /reload. */
export type ReloadRequest = {
	/** If true, bypass browser cache. Default: false. */
	ignoreCache?: boolean
}

/** Response payload for POST /reload. */
export type ReloadResponse = {
	ok: true
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
	/** Filter elements by exact trimmed textContent. */
	text?: string
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
	/** Filter elements by exact trimmed textContent. */
	text?: string
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

/**
 * Request payload for POST /dom/hover.
 */
export type DomHoverRequest = {
	/** CSS selector to match element(s). */
	selector: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by exact trimmed textContent. */
	text?: string
}

/**
 * Response payload for POST /dom/hover.
 */
export type DomHoverResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements hovered. */
	hovered: number
}

/**
 * Request payload for POST /dom/click.
 */
export type DomClickRequest = {
	/** CSS selector to match element(s). */
	selector?: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Viewport x-coordinate, or x-offset from element top-left when selector is set. */
	x?: number
	/** Viewport y-coordinate, or y-offset from element top-left when selector is set. */
	y?: number
	/** Filter elements by exact trimmed textContent. */
	text?: string
}

/**
 * Response payload for POST /dom/click.
 */
export type DomClickResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements clicked. */
	clicked: number
}

/**
 * Request payload for POST /dom/keydown.
 */
export type DomKeydownRequest = {
	/** Key name (e.g. "Enter", "a", "ArrowUp"). */
	key: string
	/** Optional CSS selector — focus element before dispatching. */
	selector?: string
	/** Comma-separated modifier names: "shift,ctrl,alt,meta". */
	modifiers?: string
}

/**
 * Response payload for POST /dom/keydown.
 */
export type DomKeydownResponse = {
	ok: true
	/** The key that was dispatched. */
	key: string
	/** Resolved modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
	modifiers: number
	/** Whether a selector was focused before dispatch. */
	focused: boolean
}

/** Valid positions for insertAdjacentHTML. */
export type DomInsertPosition = 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend'

/**
 * Request payload for POST /dom/add.
 */
export type DomAddRequest = {
	/** CSS selector to match target element(s). */
	selector: string
	/** HTML string to insert. */
	html: string
	/** Insert position relative to matched element. Default: 'beforeend'. */
	position?: DomInsertPosition
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Zero-based index of the match to insert at (mutually exclusive with all). */
	nth?: number
	/** Expected match count; request fails if mismatch (prevents accidental inserts). */
	expect?: number
	/** Insert text content instead of HTML (uses insertAdjacentText). */
	text?: boolean
}

/**
 * Response payload for POST /dom/add.
 */
export type DomAddResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements where HTML was inserted. */
	inserted: number
}

/**
 * Request payload for POST /dom/remove.
 */
export type DomRemoveRequest = {
	/** CSS selector to match element(s) to remove. */
	selector: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by exact trimmed textContent. */
	text?: string
}

/**
 * Response payload for POST /dom/remove.
 */
export type DomRemoveResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements removed. */
	removed: number
}

/**
 * Request payload for POST /dom/modify.
 * Discriminated union based on 'type' field.
 */
export type DomModifyRequest = {
	/** CSS selector to match element(s). */
	selector: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by exact trimmed textContent. */
	text?: string
} & (
	| { type: 'attr'; set?: Record<string, string | true>; remove?: string[] }
	| { type: 'class'; add?: string[]; remove?: string[]; toggle?: string[] }
	| { type: 'style'; set?: Record<string, string>; remove?: string[] }
	| { type: 'text'; value: string }
	| { type: 'html'; value: string }
)

/**
 * Response payload for POST /dom/modify.
 */
export type DomModifyResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements modified. */
	modified: number
}

/**
 * Request payload for POST /dom/set-file.
 */
export type DomSetFileRequest = {
	/** CSS selector to match file input element(s). */
	selector: string
	/** Absolute file paths to set on the input. */
	files: string[]
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by exact trimmed textContent. */
	text?: string
}

/**
 * Response payload for POST /dom/set-file.
 */
export type DomSetFileResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of file inputs updated. */
	updated: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request payload for POST /dom/fill.
 */
export type DomFillRequest = {
	/** CSS selector to match input/textarea/contenteditable element(s). */
	selector: string
	/** Value to fill into the element. */
	value: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by exact trimmed textContent. */
	text?: string
}

/**
 * Response payload for POST /dom/fill.
 */
export type DomFillResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements filled. */
	filled: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node in the accessibility tree.
 * Reconstructed from CDP's flat AXNode array into a nested structure.
 */
export type AXTreeNode = {
	/** Accessibility role (e.g. "button", "textbox", "heading", "link"). */
	role: string
	/** Accessible name (visible label or aria-label). */
	name: string
	/** Current value for inputs/selects/sliders. */
	value?: string
	/** Relevant state properties. */
	properties?: Record<string, string | number | boolean>
	/** Child nodes in the accessibility tree. */
	children?: AXTreeNode[]
}

/**
 * Request payload for POST /snapshot.
 */
export type SnapshotRequest = {
	/** CSS selector to scope the snapshot to a DOM subtree. */
	selector?: string
	/** Max depth to traverse. */
	depth?: number
	/** If true, only return interactive elements (buttons, links, inputs, etc.). */
	interactive?: boolean
}

/**
 * Response payload for POST /snapshot.
 */
export type SnapshotResponse = {
	ok: true
	/** Root nodes of the accessibility tree. */
	roots: AXTreeNode[]
	/** Total number of nodes before filtering. */
	totalNodes: number
	/** Number of nodes after filtering. */
	returnedNodes: number
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage operations
// ─────────────────────────────────────────────────────────────────────────────

/** Request payload for POST /storage/local. */
export type StorageLocalRequest = {
	/** The operation to perform. */
	action: 'get' | 'set' | 'remove' | 'list' | 'clear'
	/** Key for get/set/remove operations. */
	key?: string
	/** Value for set operation. */
	value?: string
	/** Optional origin to validate against page's current origin. */
	origin?: string
}

/** Response payload for POST /storage/local (get). */
export type StorageLocalGetResponse = {
	ok: true
	origin: string
	key: string
	exists: boolean
	value: string | null
}

/** Response payload for POST /storage/local (set). */
export type StorageLocalSetResponse = {
	ok: true
	origin: string
	key: string
}

/** Response payload for POST /storage/local (remove). */
export type StorageLocalRemoveResponse = {
	ok: true
	origin: string
	key: string
}

/** Response payload for POST /storage/local (list). */
export type StorageLocalListResponse = {
	ok: true
	origin: string
	keys: string[]
}

/** Response payload for POST /storage/local (clear). */
export type StorageLocalClearResponse = {
	ok: true
	origin: string
	cleared: number
}

/** Union of all storage local responses. */
export type StorageLocalResponse =
	| StorageLocalGetResponse
	| StorageLocalSetResponse
	| StorageLocalRemoveResponse
	| StorageLocalListResponse
	| StorageLocalClearResponse
