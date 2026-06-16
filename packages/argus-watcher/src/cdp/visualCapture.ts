import type { ScreenshotClipRegion } from '@vforsh/argus-core'
import type { CdpSessionHandle, CdpTargetContext } from './connection.js'
import { resolveFirstSelectorNodeId } from './dom/selector.js'

export type VisualCaptureClip = { x: number; y: number; width: number; height: number; scale: number }

export type VisualCaptureViewport = {
	width: number
	height: number
}

export type VisualCaptureSubject = { kind: 'viewport' } | { kind: 'selector'; selector: string } | { kind: 'clip'; clip: ScreenshotClipRegion }

export type VisualCaptureRequest = {
	selector?: string
	clip?: ScreenshotClipRegion
}

export type VisualCapturePlan = {
	session: CdpSessionHandle
	clip?: VisualCaptureClip
	viewport?: VisualCaptureViewport
}

type VisualViewport = { pageX?: number; pageY?: number; scale?: number; clientWidth?: number; clientHeight?: number }

/**
 * Resolve a viewport/selector/clip request into the top-level page session that can capture pixels.
 * Frame targets use their selected frame session for DOM lookup, then translate the clip to page pixels.
 */
export const createVisualCapturePlan = async (
	session: CdpSessionHandle,
	pageSession: CdpSessionHandle | undefined,
	request: VisualCaptureRequest,
): Promise<VisualCapturePlan> => {
	const subject = resolveVisualCaptureSubject(request)
	const targetContext = session.getTargetContext?.()
	if (targetContext?.kind === 'frame' && pageSession) {
		return createFrameCapturePlan({
			frameSession: session,
			pageSession,
			frameContext: targetContext,
			subject,
		})
	}

	const clip = await resolveSubjectClip(session, subject)
	if (!clip) {
		return { session }
	}

	return {
		session,
		clip,
		viewport: await resolveViewportSize(session),
	}
}

const createFrameCapturePlan = async (options: {
	frameSession: CdpSessionHandle
	pageSession: CdpSessionHandle
	frameContext: Extract<CdpTargetContext, { kind: 'frame' }>
	subject: VisualCaptureSubject
}): Promise<VisualCapturePlan> => {
	const frameClip = await resolveFrameViewportClip(options.pageSession, options.frameContext.frameId)
	const pageViewport = await resolveViewportSize(options.pageSession)
	const subjectClip = await resolveSubjectClip(options.frameSession, options.subject)
	if (!subjectClip) {
		return {
			session: options.pageSession,
			clip: frameClip,
			viewport: pageViewport,
		}
	}

	return {
		session: options.pageSession,
		clip: offsetClip(frameClip, subjectClip),
		viewport: pageViewport,
	}
}

const resolveFrameViewportClip = async (pageSession: CdpSessionHandle, frameId: string): Promise<VisualCaptureClip> => {
	const owner = (await pageSession.sendAndWait('DOM.getFrameOwner', {
		frameId,
	})) as { backendNodeId?: number; nodeId?: number }

	if (owner.backendNodeId == null && owner.nodeId == null) {
		throw new Error(`Unable to resolve iframe owner for frame: ${frameId}`)
	}

	return resolveNodeClip(pageSession, owner)
}

const resolveSelectorClip = async (session: CdpSessionHandle, selector: string): Promise<VisualCaptureClip> => {
	const nodeId = await resolveFirstSelectorNodeId(session, selector)
	if (!nodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	return resolveNodeClip(session, { nodeId })
}

const resolveSubjectClip = async (session: CdpSessionHandle, subject: VisualCaptureSubject): Promise<VisualCaptureClip | null> => {
	switch (subject.kind) {
		case 'viewport':
			return null
		case 'selector':
			return resolveSelectorClip(session, subject.selector)
		case 'clip':
			return resolveViewportRectClip(session, subject.clip)
	}
}

export const resolveVisualCaptureSubject = (request: VisualCaptureRequest): VisualCaptureSubject => {
	if (request.selector) {
		return { kind: 'selector', selector: request.selector }
	}
	if (request.clip) {
		return { kind: 'clip', clip: request.clip }
	}
	return { kind: 'viewport' }
}

const resolveViewportRectClip = async (session: CdpSessionHandle, clip: ScreenshotClipRegion): Promise<VisualCaptureClip> => {
	const viewport = await resolveVisualViewport(session)

	return {
		x: clip.x,
		y: clip.y,
		width: clip.width,
		height: clip.height,
		// CDP clip rectangles always need the current viewport scale, even when x/y are already viewport-relative.
		scale: viewport?.scale ?? 1,
	}
}

const resolveNodeClip = async (session: CdpSessionHandle, target: { nodeId?: number; backendNodeId?: number }): Promise<VisualCaptureClip> => {
	const boxResult = await session.sendAndWait(
		'DOM.getBoxModel',
		target.nodeId != null ? { nodeId: target.nodeId } : { backendNodeId: target.backendNodeId },
	)
	const quad =
		(boxResult as { model?: { content?: number[]; border?: number[] } }).model?.content ??
		(boxResult as { model?: { border?: number[] } }).model?.border

	if (!quad || quad.length < 8) {
		throw new Error('Unable to compute element box model')
	}

	const rect = quadToRect(quad)
	if (rect.width <= 0 || rect.height <= 0) {
		throw new Error('Element has zero area')
	}

	const viewport = await resolveVisualViewport(session)
	const pageX = viewport?.pageX ?? 0
	const pageY = viewport?.pageY ?? 0
	const scale = viewport?.scale ?? 1

	return {
		x: rect.x - pageX,
		y: rect.y - pageY,
		width: rect.width,
		height: rect.height,
		scale,
	}
}

const resolveVisualViewport = async (session: CdpSessionHandle): Promise<VisualViewport | undefined> => {
	const metrics = await session.sendAndWait('Page.getLayoutMetrics')
	const payload = metrics as { cssVisualViewport?: VisualViewport; visualViewport?: VisualViewport }
	return payload.cssVisualViewport ?? payload.visualViewport
}

const resolveViewportSize = async (session: CdpSessionHandle): Promise<VisualCaptureViewport> => {
	const viewport = await resolveVisualViewport(session)
	if (isPositiveFiniteNumber(viewport?.clientWidth) && isPositiveFiniteNumber(viewport?.clientHeight)) {
		return { width: viewport.clientWidth, height: viewport.clientHeight }
	}

	const evaluated = (await session.sendAndWait('Runtime.evaluate', {
		expression: '({width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight})',
		returnByValue: true,
	})) as { result?: { value?: { width?: number; height?: number } } }
	const width = evaluated.result?.value?.width
	const height = evaluated.result?.value?.height
	if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
		throw new Error('Unable to compute viewport size')
	}

	return { width, height }
}

const isPositiveFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const offsetClip = (outer: VisualCaptureClip, inner: VisualCaptureClip): VisualCaptureClip => ({
	x: outer.x + inner.x,
	y: outer.y + inner.y,
	width: inner.width,
	height: inner.height,
	scale: outer.scale,
})

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
