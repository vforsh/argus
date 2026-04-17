import fs from 'node:fs/promises'
import type { ScreenshotClipRegion, ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle, CdpTargetContext } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, resolveArtifactPath } from '../artifacts.js'
import { resolveFirstSelectorNodeId } from './dom/selector.js'

type Clip = { x: number; y: number; width: number; height: number; scale: number }
type VisualViewport = { pageX?: number; pageY?: number; scale?: number }

type CaptureSubject = { kind: 'viewport' } | { kind: 'selector'; selector: string } | { kind: 'clip'; clip: ScreenshotClipRegion }

type CapturePlan = {
	session: CdpSessionHandle
	clip?: Clip
}

type CaptureResult = {
	data: string
	clipped: boolean
}

export type Screenshotter = {
	capture: (request: ScreenshotRequest) => Promise<ScreenshotResponse>
}

export const createScreenshotter = (options: { session: CdpSessionHandle; pageSession?: CdpSessionHandle; artifactsDir: string }): Screenshotter => {
	const capture = async (request: ScreenshotRequest): Promise<ScreenshotResponse> => {
		const format = request.format ?? 'png'
		if (format !== 'png') {
			throw new Error(`Unsupported screenshot format: ${format}`)
		}

		await ensureArtifactsDir(options.artifactsDir)
		const defaultName = `screenshots/${new Date().toISOString().replace(/[:.]/g, '-')}.png`
		const { absolutePath, displayPath } = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)
		await ensureParentDir(absolutePath)
		const capturePlan = await createCapturePlan(options.session, options.pageSession, request)

		const result = await captureScreenshot(capturePlan.session, {
			format,
			clip: capturePlan.clip,
		})

		await fs.writeFile(absolutePath, Buffer.from(result.data, 'base64'))
		return { ok: true, outFile: displayPath, clipped: result.clipped }
	}

	return { capture }
}

/**
 * `Page.captureScreenshot` only works on top-level page targets.
 * When Argus is attached to an iframe through the extension source, we keep using the
 * selected frame session for DOM lookups but route the final screenshot through the
 * top-level page session with a translated clip rect.
 */
const createCapturePlan = async (
	session: CdpSessionHandle,
	pageSession: CdpSessionHandle | undefined,
	request: ScreenshotRequest,
): Promise<CapturePlan> => {
	const subject = resolveCaptureSubject(request)
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

	return { session, clip }
}

const createFrameCapturePlan = async (options: {
	frameSession: CdpSessionHandle
	pageSession: CdpSessionHandle
	frameContext: Extract<CdpTargetContext, { kind: 'frame' }>
	subject: CaptureSubject
}): Promise<CapturePlan> => {
	const frameClip = await resolveFrameViewportClip(options.pageSession, options.frameContext.frameId)
	const subjectClip = await resolveSubjectClip(options.frameSession, options.subject)
	if (!subjectClip) {
		return {
			session: options.pageSession,
			clip: frameClip,
		}
	}

	return {
		session: options.pageSession,
		clip: offsetClip(frameClip, subjectClip),
	}
}

const captureScreenshot = async (session: CdpSessionHandle, options: { format: 'png'; clip?: Clip }): Promise<CaptureResult> => {
	const payload = await session.sendAndWait('Page.captureScreenshot', {
		format: options.format,
		clip: options.clip,
	})

	const response = payload as { data?: string }
	if (!response.data) {
		throw new Error('Failed to capture screenshot')
	}

	return { data: response.data, clipped: Boolean(options.clip) }
}

const resolveFrameViewportClip = async (pageSession: CdpSessionHandle, frameId: string): Promise<Clip> => {
	const owner = (await pageSession.sendAndWait('DOM.getFrameOwner', {
		frameId,
	})) as { backendNodeId?: number; nodeId?: number }

	if (owner.backendNodeId == null && owner.nodeId == null) {
		throw new Error(`Unable to resolve iframe owner for frame: ${frameId}`)
	}

	return resolveNodeClip(pageSession, owner)
}

const resolveSelectorClip = async (session: CdpSessionHandle, selector: string): Promise<Clip> => {
	const nodeId = await resolveFirstSelectorNodeId(session, selector)
	if (!nodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	return resolveNodeClip(session, { nodeId })
}

const resolveSubjectClip = async (session: CdpSessionHandle, subject: CaptureSubject): Promise<Clip | null> => {
	switch (subject.kind) {
		case 'viewport':
			return null
		case 'selector':
			return resolveSelectorClip(session, subject.selector)
		case 'clip':
			return resolveViewportRectClip(session, subject.clip)
	}
}

const resolveCaptureSubject = (request: ScreenshotRequest): CaptureSubject => {
	if (request.selector) {
		return { kind: 'selector', selector: request.selector }
	}
	if (request.clip) {
		return { kind: 'clip', clip: request.clip }
	}
	return { kind: 'viewport' }
}

const resolveViewportRectClip = async (session: CdpSessionHandle, clip: ScreenshotClipRegion): Promise<Clip> => {
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

const resolveNodeClip = async (session: CdpSessionHandle, target: { nodeId?: number; backendNodeId?: number }): Promise<Clip> => {
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
	return (metrics as { visualViewport?: VisualViewport }).visualViewport
}

const offsetClip = (outer: Clip, inner: Clip): Clip => ({
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
