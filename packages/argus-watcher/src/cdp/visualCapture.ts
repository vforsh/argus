import { evaluateInPage } from './pageState.js'
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

/**
 * A resolved capture target.
 *
 * `clip` is always **viewport-relative** CSS pixels — the space `DOM.getBoxModel` reports and the
 * space a screencast frame lives in. `Page.captureScreenshot` instead wants document coordinates,
 * so a screenshot adds {@link VisualCapturePlan.pageOffset} before it sends the clip. Keeping one
 * space here and converting at the one call site that needs the other is what stops the two
 * consumers from disagreeing about what a clip means.
 */
export type VisualCapturePlan = {
	session: CdpSessionHandle
	/** Crop rectangle in viewport-relative CSS pixels. */
	clip?: VisualCaptureClip
	viewport?: VisualCaptureViewport
	/** Scroll offset of the captured viewport within the document. Set whenever `clip` is. */
	pageOffset?: { x: number; y: number }
}

/** Translate a viewport-relative clip into the document coordinates `Page.captureScreenshot` expects. */
export const toPageClip = (clip: VisualCaptureClip, pageOffset: { x: number; y: number } | undefined): VisualCaptureClip => ({
	...clip,
	x: clip.x + (pageOffset?.x ?? 0),
	y: clip.y + (pageOffset?.y ?? 0),
})

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
	const targetContext = await session.getReadyTargetContext()
	if (targetContext?.kind === 'frame' && pageSession) {
		return createFrameCapturePlan({
			frameSession: session,
			pageSession,
			frameContext: targetContext,
			subject,
		})
	}

	// Whole-viewport capture needs no geometry at all, so it costs no round-trips.
	if (subject.kind === 'viewport') {
		return { session }
	}

	const viewport = await resolveViewportState(session)
	return {
		session,
		clip: await resolveSubjectClip(session, subject, viewport),
		viewport: viewport.size,
		pageOffset: viewport.offset,
	}
}

const createFrameCapturePlan = async (options: {
	frameSession: CdpSessionHandle
	pageSession: CdpSessionHandle
	frameContext: Extract<CdpTargetContext, { kind: 'frame' }>
	subject: VisualCaptureSubject
}): Promise<VisualCapturePlan> => {
	const pageViewport = await resolveViewportState(options.pageSession)
	const frameClip = await resolveFrameViewportClip(options.pageSession, options.frameContext.frameId, pageViewport)
	if (options.subject.kind === 'viewport') {
		return {
			session: options.pageSession,
			clip: frameClip,
			viewport: pageViewport.size,
			pageOffset: pageViewport.offset,
		}
	}

	const frameViewport = await resolveViewportState(options.frameSession)
	const subjectClip = await resolveSubjectClip(options.frameSession, options.subject, frameViewport)

	return {
		session: options.pageSession,
		// Both are viewport-relative to their own document, so the sum lands in page-viewport space.
		clip: offsetClip(frameClip, subjectClip),
		viewport: pageViewport.size,
		pageOffset: pageViewport.offset,
	}
}

const resolveFrameViewportClip = async (pageSession: CdpSessionHandle, frameId: string, viewport: ViewportState): Promise<VisualCaptureClip> => {
	const owner = await pageSession.sendAndWait('DOM.getFrameOwner', {
		frameId,
	})

	if (owner.backendNodeId == null && owner.nodeId == null) {
		throw new Error(`Unable to resolve iframe owner for frame: ${frameId}`)
	}

	return resolveNodeClip(pageSession, owner, viewport)
}

const resolveSelectorClip = async (session: CdpSessionHandle, selector: string, viewport: ViewportState): Promise<VisualCaptureClip> => {
	const nodeId = await resolveFirstSelectorNodeId(session, selector)
	if (!nodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	return resolveNodeClip(session, { nodeId }, viewport)
}

/** Resolve a crop subject. Viewport subjects never reach here — they have no rectangle to resolve. */
const resolveSubjectClip = async (
	session: CdpSessionHandle,
	subject: Exclude<VisualCaptureSubject, { kind: 'viewport' }>,
	viewport: ViewportState,
): Promise<VisualCaptureClip> => {
	if (subject.kind === 'selector') {
		return resolveSelectorClip(session, subject.selector, viewport)
	}

	return {
		...subject.clip,
		// CDP clip rectangles always need the current viewport scale, even when x/y are already viewport-relative.
		scale: viewport.scale,
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

const resolveNodeClip = async (
	session: CdpSessionHandle,
	target: { nodeId?: number; backendNodeId?: number },
	viewport: ViewportState,
): Promise<VisualCaptureClip> => {
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

	/**
	 * No scroll offset is subtracted here: `DOM.getBoxModel` already reports viewport-relative CSS
	 * pixels, matching `getBoundingClientRect`. Subtracting `pageY` as well double-counted the
	 * scroll, which was invisible at scroll offset 0 and put the crop entirely off-frame anywhere
	 * else — a blank screenshot, or a 2px-tall recording.
	 */
	return {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
		scale: viewport.scale,
	}
}

const resolveVisualViewport = async (session: CdpSessionHandle): Promise<VisualViewport | undefined> => {
	const metrics = await session.sendAndWait('Page.getLayoutMetrics')
	const payload = metrics as { cssVisualViewport?: VisualViewport; visualViewport?: VisualViewport }
	return payload.cssVisualViewport ?? payload.visualViewport
}

/**
 * Everything one capture needs to know about a target's viewport, from a single metrics call.
 *
 * Size, scroll offset, and scale used to be fetched by three separate helpers, so planning one
 * cropped capture cost three or four `Page.getLayoutMetrics` round-trips — and, worse, they could
 * disagree if the page scrolled between them.
 */
type ViewportState = {
	size: VisualCaptureViewport
	/** Scroll offset of the visual viewport within the document, in CSS pixels. */
	offset: { x: number; y: number }
	scale: number
}

const resolveViewportState = async (session: CdpSessionHandle): Promise<ViewportState> => {
	const viewport = await resolveVisualViewport(session)

	return {
		size: await resolveViewportSize(session, viewport),
		offset: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0 },
		scale: viewport?.scale ?? 1,
	}
}

const resolveViewportSize = async (session: CdpSessionHandle, viewport: VisualViewport | undefined): Promise<VisualCaptureViewport> => {
	if (isPositiveFiniteNumber(viewport?.clientWidth) && isPositiveFiniteNumber(viewport?.clientHeight)) {
		return { width: viewport.clientWidth, height: viewport.clientHeight }
	}

	const evaluated = await evaluateInPage<{ width?: unknown; height?: unknown }>(
		session,
		'({width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight})',
	)
	const width = evaluated?.width
	const height = evaluated?.height
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
