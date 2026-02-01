import type { CdpSessionHandle } from './connection.js'
import { filterNodesByText } from './text-filter.js'

type SelectorMatchResult = {
	allNodeIds: number[]
	nodeIds: number[]
}

type Point = {
	x: number
	y: number
}

export const resolveDomSelectorMatches = async (
	session: CdpSessionHandle,
	selector: string,
	all: boolean,
	text?: string,
): Promise<SelectorMatchResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const result = (await session.sendAndWait('DOM.querySelectorAll', { nodeId: rootId, selector })) as { nodeIds?: number[] }
	let allNodeIds = result.nodeIds ?? []

	if (text != null) {
		allNodeIds = await filterNodesByText(session, allNodeIds, text)
	}

	const nodeIds = all ? allNodeIds : allNodeIds.slice(0, 1)

	return { allNodeIds, nodeIds }
}

export const hoverDomNodes = async (session: CdpSessionHandle, nodeIds: number[]): Promise<void> => {
	if (nodeIds.length === 0) {
		return
	}

	for (const nodeId of nodeIds) {
		await scrollIntoView(session, nodeId)
		const point = await resolveNodeCenter(session, nodeId)
		await dispatchMouseEvent(session, { type: 'mouseMoved', x: point.x, y: point.y })
	}
}

export const clickAtPoint = async (session: CdpSessionHandle, x: number, y: number): Promise<void> => {
	await dispatchMouseEvent(session, { type: 'mouseMoved', x, y })
	await dispatchMouseEvent(session, { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
	await dispatchMouseEvent(session, { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

export const resolveNodeTopLeft = async (session: CdpSessionHandle, nodeId: number): Promise<Point> => {
	const { x, y, w, h } = await resolveNodeRect(session, nodeId)
	if (w <= 0 || h <= 0) {
		throw createNotInteractableError('Element has zero area')
	}
	return { x, y }
}

export const clickDomNodes = async (session: CdpSessionHandle, nodeIds: number[]): Promise<void> => {
	if (nodeIds.length === 0) {
		return
	}

	for (const nodeId of nodeIds) {
		await scrollIntoView(session, nodeId)
		const point = await resolveNodeCenter(session, nodeId)
		await dispatchMouseEvent(session, { type: 'mouseMoved', x: point.x, y: point.y })
		await dispatchMouseEvent(session, { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
		await dispatchMouseEvent(session, { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
	}
}

const getDomRootId = async (session: CdpSessionHandle): Promise<number> => {
	const result = (await session.sendAndWait('DOM.getDocument', { depth: 1 })) as { root?: { nodeId?: number } }
	const rootId = result.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}
	return rootId
}

export const scrollIntoView = async (session: CdpSessionHandle, nodeId: number): Promise<void> => {
	try {
		await session.sendAndWait('DOM.scrollIntoViewIfNeeded', { nodeId })
		return
	} catch {
		// Fallback to runtime evaluation if CDP cannot scroll directly.
	}

	const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
	const objectId = resolved.object?.objectId
	if (!objectId) {
		throw createNotInteractableError('Unable to resolve node for scrolling')
	}

	await session.sendAndWait('Runtime.callFunctionOn', {
		objectId,
		functionDeclaration: 'function() { this.scrollIntoView({ block: "center", inline: "center" }); }',
		awaitPromise: false,
		returnByValue: true,
	})
}

type ScrollPosition = { scrollX: number; scrollY: number }

type ScrollMode = { to?: { x: number; y: number }; by?: { x: number; y: number } }

/**
 * Scroll matched DOM elements. If mode has to/by, scrolls within the element container.
 * Otherwise scrolls each element into view.
 */
export const scrollDomNodes = async (session: CdpSessionHandle, nodeIds: number[], mode: ScrollMode): Promise<ScrollPosition> => {
	if (nodeIds.length === 0) {
		return getViewportScroll(session)
	}

	for (const nodeId of nodeIds) {
		if (mode.to || mode.by) {
			await scrollElementContainer(session, nodeId, mode)
		} else {
			await scrollIntoView(session, nodeId)
		}
	}

	return getViewportScroll(session)
}

/** Scroll the page viewport to an absolute or relative position. */
export const scrollViewport = async (session: CdpSessionHandle, mode: ScrollMode): Promise<ScrollPosition> => {
	const fn = mode.to ? `window.scrollTo(${mode.to.x}, ${mode.to.y})` : `window.scrollBy(${mode.by!.x}, ${mode.by!.y})`

	await session.sendAndWait('Runtime.evaluate', {
		expression: fn,
		awaitPromise: false,
		returnByValue: true,
	})

	return getViewportScroll(session)
}

const scrollElementContainer = async (session: CdpSessionHandle, nodeId: number, mode: ScrollMode): Promise<void> => {
	const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
	const objectId = resolved.object?.objectId
	if (!objectId) {
		throw createNotInteractableError('Unable to resolve node for scrolling')
	}

	const fn = mode.to ? `function() { this.scrollTo(${mode.to!.x}, ${mode.to!.y}); }` : `function() { this.scrollBy(${mode.by!.x}, ${mode.by!.y}); }`

	await session.sendAndWait('Runtime.callFunctionOn', {
		objectId,
		functionDeclaration: fn,
		awaitPromise: false,
		returnByValue: true,
	})
}

const getViewportScroll = async (session: CdpSessionHandle): Promise<ScrollPosition> => {
	const result = (await session.sendAndWait('Runtime.evaluate', {
		expression: 'JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY})',
		returnByValue: true,
	})) as { result?: { value?: string } }

	const parsed = result.result?.value ? JSON.parse(result.result.value) : { scrollX: 0, scrollY: 0 }
	return { scrollX: parsed.scrollX, scrollY: parsed.scrollY }
}

const resolveNodeCenter = async (session: CdpSessionHandle, nodeId: number): Promise<Point> => {
	const { x, y, w, h } = await resolveNodeRect(session, nodeId)
	if (w <= 0 || h <= 0) {
		throw createNotInteractableError('Element has zero area')
	}
	return { x: x + w / 2, y: y + h / 2 }
}

/** Uses getBoundingClientRect() to get viewport-relative coordinates (no scroll-offset ambiguity). */
const resolveNodeRect = async (session: CdpSessionHandle, nodeId: number): Promise<{ x: number; y: number; w: number; h: number }> => {
	const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
	const objectId = resolved.object?.objectId
	if (!objectId) {
		throw createNotInteractableError('Unable to resolve node')
	}

	const result = (await session.sendAndWait('Runtime.callFunctionOn', {
		objectId,
		functionDeclaration: 'function(){var r=this.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}',
		returnByValue: true,
	})) as { result?: { value?: { x: number; y: number; w: number; h: number } } }

	const rect = result.result?.value
	if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
		throw createNotInteractableError('Unable to compute element rect')
	}

	return rect
}

const dispatchMouseEvent = async (
	session: CdpSessionHandle,
	options: {
		type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
		x: number
		y: number
		button?: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none'
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

const createNotInteractableError = (message: string): Error => {
	const error = new Error(message)
	;(error as Error & { code?: string }).code = 'not_interactable'
	return error
}
