import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload, type ProtocolValidationResult } from '../schema.js'
import {
	compact,
	fieldError,
	isFieldError,
	optionalBoolean,
	optionalEnum,
	optionalInteger,
	optionalNonEmptyString,
	optionalNumber,
	optionalRecord,
	optionalString,
	optionalStringArray,
	readFields,
	requireObject,
	requiredString,
	type FieldError,
} from '../schemaFields.js'

/** Stable element ref emitted by `snapshot` / `locate` and accepted by ref-aware commands. */
export type ElementRef = string

/** Shared element-target shape for commands that can address a node by selector or ref. */
export type DomElementTarget = {
	/** CSS selector to match element(s). */
	selector?: string
	/** Stable element ref such as "e12". Mutually exclusive with selector. */
	ref?: ElementRef
}

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
	/** Stable element ref when the watcher can map this element back to a DOM-backed action target. */
	ref?: ElementRef
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
export type DomInfoRequest = DomElementTarget & {
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
 * Request payload for POST /dom/keydown.
 */
export type DomKeydownRequest = {
	/** Semantic key name (e.g. "Enter", "a", "ArrowUp"). Required unless `code` is provided. */
	key?: string
	/** Physical KeyboardEvent.code override (e.g. "KeyG", "Digit1"). Required unless `key` is provided. */
	code?: string
	/** Optional CSS selector — focus element before dispatching. */
	selector?: string
	/** Comma-separated modifier names: "shift,ctrl,alt,meta". */
	modifiers?: string
}

/** Resolved KeyboardEvent/CDP shape used by POST /dom/keydown. */
export type DomKeydownEvent = {
	/** Resolved KeyboardEvent.key value. */
	key: string
	/** Resolved KeyboardEvent.code value. */
	code: string
	/** Resolved virtual key code. */
	keyCode: number
	/** Text inserted by printable keys, when any. */
	text?: string
	/** Resolved modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
	modifiers: number
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
}

/**
 * Response payload for POST /dom/keydown.
 */
export type DomKeydownResponse = {
	ok: true
	/** The key that was dispatched. */
	key: string
	/** The physical KeyboardEvent.code that was dispatched. */
	code: string
	/** Resolved modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
	modifiers: number
	/** Whether a selector was focused before dispatch. */
	focused: boolean
	/** Full resolved event shape for debugging exact key/code/modifier dispatch. */
	event: DomKeydownEvent
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
	/** Wait up to this many ms for selector to appear before executing. */
	wait?: number
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
	/** Stable element ref to scroll. Mutually exclusive with selector. */
	ref?: ElementRef
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
 * Dispatches mouse wheel input via CDP Input.dispatchMouseEvent (type=mouseWheel).
 */
export type DomScrollRequest = {
	/** CSS selector to match element(s) — scroll origin is element center. */
	selector?: string
	/** Stable element ref — scroll origin is element center. Mutually exclusive with selector/x/y. */
	ref?: ElementRef
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
export type DomFillRequest = DomElementTarget & {
	/** Value to fill into the element. */
	value: string
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
	/** Wait up to this many ms for selector to appear before executing. */
	wait?: number
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
export type DomFocusRequest = DomElementTarget & {
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

// ─────────────────────────────────────────────────────────────────────────────
// Request schemas
//
// These own body validation for the DOM routes. The watcher used to re-prove each
// payload field by field inside the route, which is where "non-empty string" and
// "non-negative integer" drifted between endpoints; the checks now live beside the
// types they validate.
// ─────────────────────────────────────────────────────────────────────────────

/** Insert positions accepted by POST /dom/add. */
export const DOM_INSERT_POSITIONS = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'] as const

/** Modification kinds accepted by POST /dom/modify. */
export const DOM_MODIFY_TYPES = ['attr', 'class', 'style', 'text', 'html'] as const

/** Readers for the selector/ref/all/text target every DOM route accepts. */
const domTargetReaders = {
	selector: optionalNonEmptyString,
	ref: optionalNonEmptyString,
	all: optionalBoolean,
	text: optionalString,
}

/** Require exactly one of selector/ref, the rule every ref-aware DOM route enforces. */
const requireExactlyOneTarget = (target: { selector?: string; ref?: ElementRef }): string | null =>
	Boolean(target.selector) === Boolean(target.ref) ? 'Exactly one of selector or ref is required' : null

/**
 * Validate the selector/ref/all/text/wait body every element-target route shares.
 *
 * `defineDomTargetRoute` resolves the target for hover/focus/fill identically, so the
 * body rules are identical too; routes that add fields layer them on top of this.
 */
export const domTargetPayload = <T extends DomElementTarget & { all?: boolean; text?: string; wait?: number }>(
	value: unknown,
): ProtocolValidationResult<T> => {
	const invalid = requireObject<T>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		...domTargetReaders,
		wait: (source, key) => optionalNumber(source, key, { min: 0 }),
	})
	if (!fields.ok) return fields

	const targetError = requireExactlyOneTarget(fields.value)
	if (targetError) return invalidProtocolPayload(targetError)

	return validProtocolPayload(compact(fields.value) as T)
}

/** Schema for POST /dom/info request payloads. */
export const domInfoRequestSchema = defineProtocolSchema<DomInfoRequest>((value) => {
	const invalid = requireObject<DomInfoRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		...domTargetReaders,
		outerHtmlMaxChars: (source, key) => optionalInteger(source, key, { min: 0 }),
	})
	if (!fields.ok) return fields

	const targetError = requireExactlyOneTarget(fields.value)
	if (targetError) return invalidProtocolPayload(targetError)

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/remove request payloads. */
export const domRemoveRequestSchema = defineProtocolSchema<DomRemoveRequest>((value) => {
	const invalid = requireObject<DomRemoveRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: requiredString,
		all: optionalBoolean,
		text: optionalString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/tree request payloads. */
export const domTreeRequestSchema = defineProtocolSchema<DomTreeRequest>((value) => {
	const invalid = requireObject<DomTreeRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: requiredString,
		depth: (source, key) => optionalInteger(source, key, { min: 0 }),
		maxNodes: (source, key) => optionalInteger(source, key, { min: 1 }),
		all: optionalBoolean,
		text: optionalString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/add request payloads. */
export const domAddRequestSchema = defineProtocolSchema<DomAddRequest>((value) => {
	const invalid = requireObject<DomAddRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: requiredString,
		html: requiredString,
		position: (source, key) => optionalEnum(source, key, DOM_INSERT_POSITIONS),
		all: optionalBoolean,
		nth: (source, key) => optionalInteger(source, key, { min: 0 }),
		expect: (source, key) => optionalInteger(source, key, { min: 0 }),
		text: optionalBoolean,
	})
	if (!fields.ok) return fields

	if (fields.value.all === true && fields.value.nth != null) {
		return invalidProtocolPayload('nth cannot be combined with all=true')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/modify request payloads. */
export const domModifyRequestSchema = defineProtocolSchema<DomModifyRequest>((value) => {
	const invalid = requireObject<DomModifyRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const fields = readFields(source, {
		selector: requiredString,
		all: optionalBoolean,
		text: optionalString,
		type: (input, key) => optionalEnum(input, key, DOM_MODIFY_TYPES),
	})
	if (!fields.ok) return fields
	const { type } = fields.value

	if (type == null) {
		return invalidProtocolPayload(`type must be one of: ${DOM_MODIFY_TYPES.join(', ')}`)
	}
	if ((type === 'text' || type === 'html') && typeof source.value !== 'string') {
		return invalidProtocolPayload('value is required for text/html modifications')
	}

	// The per-type payload (set/remove/add/toggle/value) passes through: it is a
	// discriminated union the page-side function reads, and callers get its type checking.
	return validProtocolPayload(compact({ ...source, ...fields.value }) as unknown as DomModifyRequest)
})

/** Schema for POST /dom/keydown request payloads. */
export const domKeydownRequestSchema = defineProtocolSchema<DomKeydownRequest>((value) => {
	const invalid = requireObject<DomKeydownRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		key: optionalNonEmptyString,
		code: optionalNonEmptyString,
		selector: optionalNonEmptyString,
		modifiers: optionalString,
	})
	if (!fields.ok) return fields

	if (fields.value.key == null && fields.value.code == null) {
		return invalidProtocolPayload('key or code is required')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/focus request payloads. */
export const domFocusRequestSchema = defineProtocolSchema<DomFocusRequest>((value) => domTargetPayload<DomFocusRequest>(value))

/** Schema for POST /dom/fill request payloads. */
export const domFillRequestSchema = defineProtocolSchema<DomFillRequest>((value) => {
	const base = domTargetPayload<DomFillRequest>(value)
	if (!base.ok) return base

	const fillValue = (value as Record<string, unknown>).value
	if (typeof fillValue !== 'string') {
		return invalidProtocolPayload('value is required')
	}

	return validProtocolPayload({ ...base.value, value: fillValue })
})

/** Read a required `{ x, y }` point. */
const requiredPoint = (source: Record<string, unknown>, key: string): { x: number; y: number } | FieldError => {
	const point = optionalRecord(source, key)
	if (point == null || isFieldError(point)) {
		return fieldError(`${key} is required with { x, y } numbers`)
	}
	if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		return fieldError(`${key}.x and ${key}.y must be finite numbers`)
	}
	return { x: point.x, y: point.y }
}

/** Read an optional `{ x, y }` point. */
const optionalPoint = (source: Record<string, unknown>, key: string): { x: number; y: number } | undefined | FieldError => {
	if (source[key] == null) return undefined
	return requiredPoint(source, key)
}

/** Schema for POST /dom/scroll request payloads. */
export const domScrollRequestSchema = defineProtocolSchema<DomScrollRequest>((value) => {
	const invalid = requireObject<DomScrollRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const fields = readFields(source, {
		delta: requiredPoint,
		selector: optionalNonEmptyString,
		x: optionalNumber,
		y: optionalNumber,
		all: optionalBoolean,
		text: optionalString,
	})
	if (!fields.ok) return fields
	const { selector, x, y } = fields.value

	const hasPosition = source.x != null || source.y != null
	if (selector && hasPosition) {
		return invalidProtocolPayload('selector and x/y coordinates are mutually exclusive')
	}
	if (hasPosition && (x == null || y == null)) {
		return invalidProtocolPayload('x and y must both be finite numbers')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/scroll-to request payloads. */
export const domScrollToRequestSchema = defineProtocolSchema<DomScrollToRequest>((value) => {
	const invalid = requireObject<DomScrollToRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: optionalNonEmptyString,
		to: optionalPoint,
		by: optionalPoint,
		all: optionalBoolean,
		text: optionalString,
	})
	if (!fields.ok) return fields
	const { selector, to, by } = fields.value

	if (!selector && to == null && by == null) {
		return invalidProtocolPayload('at least one of selector, to, or by is required')
	}
	if (to != null && by != null) {
		return invalidProtocolPayload('to and by are mutually exclusive')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /dom/set-file request payloads. */
export const domSetFileRequestSchema = defineProtocolSchema<DomSetFileRequest>((value) => {
	const invalid = requireObject<DomSetFileRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: requiredString,
		files: optionalStringArray,
		all: optionalBoolean,
		text: optionalString,
		wait: (source, key) => optionalNumber(source, key, { min: 0 }),
	})
	if (!fields.ok) return fields

	if (!fields.value.files || fields.value.files.length === 0) {
		return invalidProtocolPayload('files array is required and must not be empty')
	}

	return validProtocolPayload(compact({ ...fields.value, files: fields.value.files }))
})
