import { callFunctionOnNode, evaluateInPage } from './pageState.js'
import type { CdpSessionHandle } from './connection.js'
import { resolveSelectorTargets, toDomNodeDescriptor, type DomNodeHandle } from './dom/selector.js'

type SelectorMatchResult = {
	allNodeIds: number[]
	nodeIds: number[]
}

type Point = {
	x: number
	y: number
}

export type MouseButton = 'left' | 'middle' | 'right'
type CdpMouseButton = MouseButton | 'back' | 'forward' | 'none'
export type DragDestination = { to: Point } | { delta: Point }
export type DragGestureOptions = {
	button?: MouseButton
	durationMs?: number
	steps?: number
}

export const resolveDomSelectorMatches = async (
	session: CdpSessionHandle,
	selector: string,
	all: boolean,
	text?: string,
): Promise<SelectorMatchResult> => {
	return resolveSelectorTargets(session, { selector, all, text })
}

export const hoverDomNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[]): Promise<void> => {
	if (handles.length === 0) {
		return
	}

	for (const handle of handles) {
		await scrollIntoView(session, handle)
		const point = await resolveNodePoint(session, handle)
		await dispatchMouseEvent(session, { type: 'mouseMoved', x: point.x, y: point.y })
	}
}

/** CDP buttons bitmask per button name. */
const BUTTON_MASK: Record<MouseButton, number> = { left: 1, middle: 4, right: 2 }

export const clickAtPoint = async (session: CdpSessionHandle, x: number, y: number, button: MouseButton = 'left'): Promise<void> => {
	const mask = BUTTON_MASK[button] ?? 1
	await dispatchMouseEvent(session, { type: 'mouseMoved', x, y })
	await dispatchMouseEvent(session, { type: 'mousePressed', x, y, button, buttons: mask, clickCount: 1 })
	await dispatchMouseEvent(session, { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
}

export const dragAtPoints = async (session: CdpSessionHandle, start: Point, end: Point, options: DragGestureOptions = {}): Promise<void> => {
	const button = options.button ?? 'left'
	const mask = BUTTON_MASK[button] ?? 1
	const steps = Math.max(1, Math.floor(options.steps ?? 12))
	const durationMs = Math.max(0, options.durationMs ?? 250)
	const stepDelayMs = durationMs / steps
	let latest = start
	let pressed = false

	await dispatchMouseEvent(session, { type: 'mouseMoved', x: start.x, y: start.y })
	try {
		await dispatchMouseEvent(session, { type: 'mousePressed', x: start.x, y: start.y, button, buttons: mask, clickCount: 1 })
		pressed = true

		for (let i = 1; i <= steps; i++) {
			if (stepDelayMs > 0) {
				await sleep(stepDelayMs)
			}
			latest = interpolatePoint(start, end, i / steps)
			await dispatchMouseEvent(session, { type: 'mouseMoved', x: latest.x, y: latest.y, button, buttons: mask, clickCount: 1 })
		}

		await dispatchMouseEvent(session, { type: 'mouseReleased', x: end.x, y: end.y, button, buttons: 0, clickCount: 1 })
		pressed = false
	} finally {
		if (pressed) {
			await dispatchMouseEvent(session, { type: 'mouseReleased', x: latest.x, y: latest.y, button, buttons: 0, clickCount: 1 }).catch(
				() => undefined,
			)
		}
	}
}

export const dragDomNodes = async (
	session: CdpSessionHandle,
	handles: DomNodeHandle[],
	destination: DragDestination,
	options: DragGestureOptions & { offset?: Point } = {},
): Promise<void> => {
	if (handles.length === 0) {
		return
	}

	for (const handle of handles) {
		await scrollIntoView(session, handle)
		const start = await resolveNodePoint(session, handle, options.offset)
		await dragAtPoints(session, start, resolveDragEndPoint(start, destination), options)
	}
}

export const resolveDragEndPoint = (start: Point, destination: DragDestination): Point => {
	if ('to' in destination) {
		return destination.to
	}
	return {
		x: start.x + destination.delta.x,
		y: start.y + destination.delta.y,
	}
}

export const clickDomNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[], button: MouseButton = 'left'): Promise<void> => {
	if (handles.length === 0) {
		return
	}

	const mask = BUTTON_MASK[button] ?? 1
	for (const handle of handles) {
		await scrollIntoView(session, handle)
		const point = await resolveNodePoint(session, handle)
		await dispatchMouseEvent(session, { type: 'mouseMoved', x: point.x, y: point.y })
		await dispatchMouseEvent(session, { type: 'mousePressed', x: point.x, y: point.y, button, buttons: mask, clickCount: 1 })
		await dispatchMouseEvent(session, { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1 })
	}
}

export const focusDomNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[]): Promise<void> => {
	if (handles.length === 0) {
		return
	}

	for (const handle of handles) {
		await scrollIntoView(session, handle)
		await session.sendAndWait('DOM.focus', toDomNodeDescriptor(handle))
	}
}

export const scrollIntoView = async (session: CdpSessionHandle, handle: DomNodeHandle): Promise<void> => {
	const descriptor = toDomNodeDescriptor(handle)
	try {
		await session.sendAndWait('DOM.scrollIntoViewIfNeeded', descriptor)
		return
	} catch {
		// Fallback to runtime evaluation if CDP cannot scroll directly.
	}

	await callFunctionOnNode(
		session,
		descriptor,
		{ code: 'function() { this.scrollIntoView({ block: "center", inline: "center" }); }' },
		{ onUnresolved: () => createNotInteractableError('Unable to resolve node for scrolling') },
	)
}

type ScrollPosition = { scrollX: number; scrollY: number }

type ScrollMode = { to?: { x: number; y: number }; by?: { x: number; y: number } }

/**
 * Scroll matched DOM elements. If mode has to/by, scrolls within the element container.
 * Otherwise scrolls each element into view.
 */
export const scrollDomNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[], mode: ScrollMode): Promise<ScrollPosition> => {
	if (handles.length === 0) {
		return getViewportScroll(session)
	}

	for (const handle of handles) {
		if (mode.to || mode.by) {
			await scrollElementContainer(session, handle, mode)
		} else {
			await scrollIntoView(session, handle)
		}
	}

	return getViewportScroll(session)
}

/** Scroll the page viewport to an absolute or relative position. */
export const scrollViewport = async (session: CdpSessionHandle, mode: ScrollMode): Promise<ScrollPosition> => {
	const fn = mode.to ? `window.scrollTo(${mode.to.x}, ${mode.to.y})` : `window.scrollBy(${mode.by!.x}, ${mode.by!.y})`

	await evaluateInPage(session, fn)

	return getViewportScroll(session)
}

const scrollElementContainer = async (session: CdpSessionHandle, handle: DomNodeHandle, mode: ScrollMode): Promise<void> => {
	const fn = mode.to ? `function() { this.scrollTo(${mode.to!.x}, ${mode.to!.y}); }` : `function() { this.scrollBy(${mode.by!.x}, ${mode.by!.y}); }`

	await callFunctionOnNode(
		session,
		toDomNodeDescriptor(handle),
		{ code: fn },
		{
			onUnresolved: () => createNotInteractableError('Unable to resolve node for scrolling'),
		},
	)
}

const getViewportScroll = async (session: CdpSessionHandle): Promise<ScrollPosition> => {
	const serialized = await evaluateInPage<string | undefined>(session, 'JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY})')
	const parsed: ScrollPosition = serialized ? JSON.parse(serialized) : { scrollX: 0, scrollY: 0 }
	return { scrollX: parsed.scrollX, scrollY: parsed.scrollY }
}

export const resolveNodePoint = async (session: CdpSessionHandle, handle: DomNodeHandle, offset?: Point): Promise<Point> => {
	const { x, y, w, h } = await resolveNodeRect(session, handle)
	if (w <= 0 || h <= 0) {
		throw createNotInteractableError('Element has zero area')
	}
	if (offset) {
		return { x: x + offset.x, y: y + offset.y }
	}
	return { x: x + w / 2, y: y + h / 2 }
}

/** Uses getBoundingClientRect() to get viewport-relative coordinates (no scroll-offset ambiguity). */
const resolveNodeRect = async (session: CdpSessionHandle, handle: DomNodeHandle): Promise<{ x: number; y: number; w: number; h: number }> => {
	const descriptor = toDomNodeDescriptor(handle)
	const boxModel = await session.sendAndWait('DOM.getBoxModel', descriptor).catch(() => null)
	const quad = boxModel?.model?.border ?? boxModel?.model?.content
	if (quad && quad.length >= 8) {
		const xs = [quad[0], quad[2], quad[4], quad[6]]
		const ys = [quad[1], quad[3], quad[5], quad[7]]
		const minX = Math.min(...xs)
		const maxX = Math.max(...xs)
		const minY = Math.min(...ys)
		const maxY = Math.max(...ys)
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
	}

	const rect = await callFunctionOnNode<{ x: number; y: number; w: number; h: number }>(session, descriptor, {
		code: 'function(){var r=this.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}',
	})
	if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
		throw createNotInteractableError('Unable to compute element rect')
	}

	return rect
}

/** Dispatch a mouseWheel event at the given viewport coordinates. */
export const emulateScroll = async (session: CdpSessionHandle, x: number, y: number, delta: { x: number; y: number }): Promise<void> => {
	await session.sendAndWait('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX: delta.x,
		deltaY: delta.y,
	})
}

/** Dispatch mouse wheel input on resolved DOM nodes (uses each element's center point). */
export const emulateScrollOnNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[], delta: { x: number; y: number }): Promise<void> => {
	if (handles.length === 0) {
		return
	}

	for (const handle of handles) {
		await scrollIntoView(session, handle)
		const point = await resolveNodePoint(session, handle)
		await emulateScroll(session, point.x, point.y, delta)
	}
}

const dispatchMouseEvent = async (
	session: CdpSessionHandle,
	options: {
		type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
		x: number
		y: number
		button?: CdpMouseButton
		buttons?: number
		clickCount?: number
	},
): Promise<void> => {
	await session.sendAndWait('Input.dispatchMouseEvent', {
		type: options.type,
		x: options.x,
		y: options.y,
		button: options.button,
		buttons: options.buttons,
		clickCount: options.clickCount,
	})
}

const interpolatePoint = (start: Point, end: Point, progress: number): Point => ({
	x: start.x + (end.x - start.x) * progress,
	y: start.y + (end.y - start.y) * progress,
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const createNotInteractableError = (message: string): Error => {
	const error = new Error(message)
	;(error as Error & { code?: string }).code = 'not_interactable'
	return error
}
