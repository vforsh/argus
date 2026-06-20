import { defineProtocolSchema, invalidProtocolPayload, isProtocolObject, validProtocolPayload } from '../schema.js'
import type { DomElementTarget, ElementRef } from './dom.js'

/** Viewport coordinate or delta used by pointer/mouse interaction commands. */
export type DomPoint = {
	/** CSS pixel x-coordinate or horizontal delta. */
	x: number
	/** CSS pixel y-coordinate or vertical delta. */
	y: number
}

/**
 * Request payload for POST /dom/hover.
 */
export type DomHoverRequest = DomElementTarget & {
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

/** Mouse button for pointer-style interaction commands. Default: 'left'. */
export type MouseButton = 'left' | 'middle' | 'right'

/** Runtime list of mouse buttons accepted by pointer-style interaction commands. */
export const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const

/**
 * Request payload for POST /dom/click.
 */
export type DomClickRequest = {
	/** CSS selector to match element(s). */
	selector?: string
	/** Stable element ref to click. Mutually exclusive with selector. */
	ref?: ElementRef
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Viewport x-coordinate, or x-offset from element top-left when selector is set. */
	x?: number
	/** Viewport y-coordinate, or y-offset from element top-left when selector is set. */
	y?: number
	/** Mouse button to click. Default: 'left'. */
	button?: MouseButton
	/** Filter elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
	/** Wait up to this many ms for selector to appear before executing. */
	wait?: number
}

/** Schema for POST /dom/click request payloads. */
export const domClickRequestSchema = defineProtocolSchema<DomClickRequest>((value) => {
	if (!isProtocolObject(value)) {
		return invalidProtocolPayload('request body must be an object')
	}

	const selector = optionalString(value, 'selector')
	const ref = optionalString(value, 'ref')
	const hasSelector = selector != null && selector.length > 0
	const hasRef = ref != null && ref.length > 0
	const hasCoords = value.x != null || value.y != null

	if (!hasSelector && !hasRef && !hasCoords) {
		return invalidProtocolPayload('selector, ref, or x,y coordinates are required')
	}
	if (hasSelector && hasRef) {
		return invalidProtocolPayload('selector and ref are mutually exclusive')
	}
	if (hasCoords && (!isFiniteNumber(value.x) || !isFiniteNumber(value.y))) {
		return invalidProtocolPayload('both x and y must be finite numbers')
	}
	if (value.all != null && typeof value.all !== 'boolean') {
		return invalidProtocolPayload('all must be a boolean')
	}
	if (value.button != null && !isMouseButton(value.button)) {
		return invalidProtocolPayload(`button must be one of: ${MOUSE_BUTTONS.join(', ')}`)
	}
	if (value.wait != null && (!isFiniteNumber(value.wait) || value.wait < 0)) {
		return invalidProtocolPayload('wait must be a non-negative number (ms)')
	}
	if (value.text != null && typeof value.text !== 'string') {
		return invalidProtocolPayload('text must be a string')
	}

	const request: DomClickRequest = {
		all: value.all ?? false,
		button: value.button ?? 'left',
		wait: value.wait ?? 0,
	}
	if (hasSelector) request.selector = selector
	if (hasRef) request.ref = ref
	if (hasCoords) {
		request.x = value.x as number
		request.y = value.y as number
	}
	if (typeof value.text === 'string') {
		request.text = value.text
	}

	return validProtocolPayload(request)
})

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
 * Request payload for POST /dom/drag.
 *
 * When selector/ref is present, x/y is an optional offset from the element's
 * top-left corner. Without selector/ref, x/y is the required viewport start.
 */
export type DomDragRequest = {
	/** CSS selector to match element(s). */
	selector?: string
	/** Stable element ref to drag from. Mutually exclusive with selector. */
	ref?: ElementRef
	/** Allow multiple matches. If false and >1 match, error. Default: false. */
	all?: boolean
	/** Viewport x-coordinate, or x-offset from element top-left when selector/ref is set. */
	x?: number
	/** Viewport y-coordinate, or y-offset from element top-left when selector/ref is set. */
	y?: number
	/** Absolute viewport destination. Mutually exclusive with delta. */
	to?: DomPoint
	/** Destination delta from the resolved start point. Mutually exclusive with to. */
	delta?: DomPoint
	/** Mouse button to hold during the drag. Default: 'left'. */
	button?: MouseButton
	/** Filter start elements by trimmed textContent. Plain string = exact match. /regex/flags = regex test. */
	text?: string
	/** Wait up to this many ms for selector to appear before executing. */
	wait?: number
	/** Total drag duration in ms. Default: 250. */
	duration?: number
	/** Number of mouseMoved events between press and release. Default: 12. */
	steps?: number
}

/** Schema for POST /dom/drag request payloads. */
export const domDragRequestSchema = defineProtocolSchema<DomDragRequest>((value) => {
	if (!isProtocolObject(value)) {
		return invalidProtocolPayload('request body must be an object')
	}

	const selector = optionalString(value, 'selector')
	const ref = optionalString(value, 'ref')
	const hasSelector = selector != null && selector.length > 0
	const hasRef = ref != null && ref.length > 0
	const hasCoords = value.x != null || value.y != null
	const hasTo = value.to != null
	const hasDelta = value.delta != null
	const to = optionalPoint(value, 'to')
	const delta = optionalPoint(value, 'delta')

	if (!hasSelector && !hasRef && !hasCoords) {
		return invalidProtocolPayload('selector, ref, or x,y start coordinates are required')
	}
	if (hasSelector && hasRef) {
		return invalidProtocolPayload('selector and ref are mutually exclusive')
	}
	if (hasCoords && (!isFiniteNumber(value.x) || !isFiniteNumber(value.y))) {
		return invalidProtocolPayload('both x and y must be finite numbers')
	}
	if (hasTo === hasDelta) {
		return invalidProtocolPayload('exactly one of to or delta is required')
	}
	if (!to.ok) {
		return invalidProtocolPayload(to.message)
	}
	if (!delta.ok) {
		return invalidProtocolPayload(delta.message)
	}
	if (value.all != null && typeof value.all !== 'boolean') {
		return invalidProtocolPayload('all must be a boolean')
	}
	if (value.button != null && !isMouseButton(value.button)) {
		return invalidProtocolPayload(`button must be one of: ${MOUSE_BUTTONS.join(', ')}`)
	}
	if (value.wait != null && (!isFiniteNumber(value.wait) || value.wait < 0)) {
		return invalidProtocolPayload('wait must be a non-negative number (ms)')
	}
	if (value.duration != null && (!isFiniteNumber(value.duration) || value.duration < 0)) {
		return invalidProtocolPayload('duration must be a non-negative number (ms)')
	}
	if (value.steps != null && !isPositiveInteger(value.steps)) {
		return invalidProtocolPayload('steps must be a positive integer')
	}
	if (value.text != null && typeof value.text !== 'string') {
		return invalidProtocolPayload('text must be a string')
	}

	const request: DomDragRequest = {
		all: value.all ?? false,
		button: value.button ?? 'left',
		wait: value.wait ?? 0,
		duration: value.duration ?? 250,
		steps: value.steps ?? 12,
	}
	if (hasSelector) request.selector = selector
	if (hasRef) request.ref = ref
	if (hasCoords) {
		request.x = value.x as number
		request.y = value.y as number
	}
	if (to.ok && to.point) request.to = to.point
	if (delta.ok && delta.point) request.delta = delta.point
	if (typeof value.text === 'string') request.text = value.text

	return validProtocolPayload(request)
})

/**
 * Response payload for POST /dom/drag.
 */
export type DomDragResponse = {
	ok: true
	/** Number of elements matched by selector/ref. Zero for coordinate-only drags. */
	matches: number
	/** Number of drag gestures completed. */
	dragged: number
}

const optionalString = (value: Record<string, unknown>, key: string): string | undefined => {
	const field = value[key]
	return typeof field === 'string' ? field : undefined
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isPositiveInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 1

const isMouseButton = (value: unknown): value is MouseButton => typeof value === 'string' && MOUSE_BUTTONS.includes(value as MouseButton)

type OptionalPointResult = { ok: true; point?: DomPoint } | { ok: false; message: string }

const optionalPoint = (value: Record<string, unknown>, key: string): OptionalPointResult => {
	const field = value[key]
	if (field == null) {
		return { ok: true }
	}
	if (!isProtocolObject(field)) {
		return { ok: false, message: `${key} must be an object with finite x and y numbers` }
	}
	if (!isFiniteNumber(field.x) || !isFiniteNumber(field.y)) {
		return { ok: false, message: `${key}.x and ${key}.y must be finite numbers` }
	}
	return { ok: true, point: { x: field.x, y: field.y } }
}
