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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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

/**
 * Request payload for POST /dom/scroll-to.
 * At least one of selector, to, or by must be provided.
 */
export type DomScrollToRequest = {
	/** CSS selector to match element(s). */
	selector?: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
	/** Scroll to absolute position { x, y }. Applies to viewport or matched element. */
	to?: { x: number; y: number }
	/** Scroll by delta { x, y }. Applies to viewport or matched element. */
	by?: { x: number; y: number }
}

/**
 * Response payload for POST /dom/scroll-to.
 */
export type DomScrollToResponse = {
	ok: true
	/** Number of elements matched by selector (only when selector is used). */
	matches?: number
	/** Number of elements scrolled (only when selector is used). */
	scrolled?: number
	/** Final horizontal scroll position. */
	scrollX: number
	/** Final vertical scroll position. */
	scrollY: number
}

/**
 * Request payload for POST /dom/scroll.
 * Emulates touch scroll gestures via CDP Input.emulateTouchScrollGesture.
 */
export type DomScrollRequest = {
	/** CSS selector to match element(s) — scroll origin is element center. */
	selector?: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
	/** Viewport x-coordinate to scroll at (alternative to selector). */
	x?: number
	/** Viewport y-coordinate to scroll at (alternative to selector). */
	y?: number
	/** Scroll delta. Required. Positive y = scroll down. */
	delta: { x: number; y: number }
}

/**
 * Response payload for POST /dom/scroll.
 */
export type DomScrollResponse = {
	ok: true
	/** Number of elements matched by selector (only when selector is used). */
	matches?: number
	/** Number of elements scrolled (only when selector is used). */
	scrolled?: number
}

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
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
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

/**
 * Request payload for POST /dom/focus.
 */
export type DomFocusRequest = {
	/** CSS selector to match element(s). */
	selector: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
}

/**
 * Response payload for POST /dom/focus.
 */
export type DomFocusResponse = {
	ok: true
	/** Number of elements matched by selector. */
	matches: number
	/** Number of elements focused. */
	focused: number
}
