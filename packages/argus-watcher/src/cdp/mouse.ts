import type { CdpSessionHandle } from './connection.js'

type SelectorMatchResult = {
	allNodeIds: number[]
	nodeIds: number[]
}

type Point = {
	x: number
	y: number
}

export const resolveDomSelectorMatches = async (session: CdpSessionHandle, selector: string, all: boolean): Promise<SelectorMatchResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const result = (await session.sendAndWait('DOM.querySelectorAll', { nodeId: rootId, selector })) as { nodeIds?: number[] }
	const allNodeIds = result.nodeIds ?? []
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
	const quad = await resolveNodeQuad(session, nodeId)
	const rect = quadToRect(quad)
	const { pageX, pageY } = await resolveViewportOffset(session)
	return { x: rect.x - pageX, y: rect.y - pageY }
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

const scrollIntoView = async (session: CdpSessionHandle, nodeId: number): Promise<void> => {
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

const resolveNodeCenter = async (session: CdpSessionHandle, nodeId: number): Promise<Point> => {
	const quad = await resolveNodeQuad(session, nodeId)
	const rect = quadToRect(quad)
	if (rect.width <= 0 || rect.height <= 0) {
		throw createNotInteractableError('Element has zero area')
	}

	const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
	const { pageX, pageY } = await resolveViewportOffset(session)
	const x = center.x - pageX
	const y = center.y - pageY

	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw createNotInteractableError('Element center is not a finite point')
	}

	return { x, y }
}

const resolveNodeQuad = async (session: CdpSessionHandle, nodeId: number): Promise<number[]> => {
	try {
		const contentQuads = (await session.sendAndWait('DOM.getContentQuads', { nodeId })) as { quads?: number[][] }
		const quad = contentQuads.quads?.[0]
		if (quad && quad.length >= 8) {
			return quad
		}
	} catch {
		// Fall back to box model when content quads are unavailable.
	}

	const boxResult = (await session.sendAndWait('DOM.getBoxModel', { nodeId })) as {
		model?: { content?: number[]; border?: number[] }
	}
	const boxQuad = boxResult.model?.content ?? boxResult.model?.border
	if (!boxQuad || boxQuad.length < 8) {
		throw createNotInteractableError('Unable to compute element box')
	}

	return boxQuad
}

const resolveViewportOffset = async (session: CdpSessionHandle): Promise<{ pageX: number; pageY: number }> => {
	const metrics = (await session.sendAndWait('Page.getLayoutMetrics')) as { visualViewport?: { pageX?: number; pageY?: number } }
	return {
		pageX: metrics.visualViewport?.pageX ?? 0,
		pageY: metrics.visualViewport?.pageY ?? 0,
	}
}

const quadToRect = (quad: number[]): { x: number; y: number; width: number; height: number } => {
	const xs = [quad[0], quad[2], quad[4], quad[6]]
	const ys = [quad[1], quad[3], quad[5], quad[7]]
	const minX = Math.min(...xs)
	const maxX = Math.max(...xs)
	const minY = Math.min(...ys)
	const maxY = Math.max(...ys)

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	}
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
