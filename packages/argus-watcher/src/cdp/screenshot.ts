import fs from 'node:fs/promises'
import type { ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, resolveArtifactPath } from '../artifacts.js'

type Clip = { x: number; y: number; width: number; height: number; scale: number }

type CaptureResult = {
	data: string
	clipped: boolean
}

export type Screenshotter = {
	capture: (request: ScreenshotRequest) => Promise<ScreenshotResponse>
}

export const createScreenshotter = (options: { session: CdpSessionHandle; artifactsDir: string }): Screenshotter => {
	const capture = async (request: ScreenshotRequest): Promise<ScreenshotResponse> => {
		const format = request.format ?? 'png'
		if (format !== 'png') {
			throw new Error(`Unsupported screenshot format: ${format}`)
		}

		await ensureArtifactsDir(options.artifactsDir)
		const defaultName = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
		const { absolutePath, displayPath } = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)

		const result = await captureScreenshot(options.session, {
			selector: request.selector,
			format,
		})

		await fs.writeFile(absolutePath, Buffer.from(result.data, 'base64'))
		return { ok: true, outFile: displayPath, clipped: result.clipped }
	}

	return { capture }
}

const captureScreenshot = async (
	session: CdpSessionHandle,
	options: { selector?: string; format: 'png' },
): Promise<CaptureResult> => {
	let clip: Clip | undefined

	if (options.selector) {
		clip = await resolveClip(session, options.selector)
	}

	const payload = await session.sendAndWait('Page.captureScreenshot', {
		format: options.format,
		clip,
	})

	const response = payload as { data?: string }
	if (!response.data) {
		throw new Error('Failed to capture screenshot')
	}

	return { data: response.data, clipped: Boolean(clip) }
}

const resolveClip = async (session: CdpSessionHandle, selector: string): Promise<Clip> => {
	await session.sendAndWait('DOM.enable')

	const documentResult = await session.sendAndWait('DOM.getDocument', { depth: 1 })
	const root = documentResult as { root?: { nodeId?: number } }
	const rootId = root.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}

	const queryResult = await session.sendAndWait('DOM.querySelector', { nodeId: rootId, selector })
	const nodeId = (queryResult as { nodeId?: number }).nodeId
	if (!nodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	const boxResult = await session.sendAndWait('DOM.getBoxModel', { nodeId })
	const quad = (boxResult as { model?: { content?: number[]; border?: number[] } }).model?.content
		?? (boxResult as { model?: { border?: number[] } }).model?.border

	if (!quad || quad.length < 8) {
		throw new Error('Unable to compute element box model')
	}

	const rect = quadToRect(quad)
	if (rect.width <= 0 || rect.height <= 0) {
		throw new Error('Element has zero area')
	}

	const metrics = await session.sendAndWait('Page.getLayoutMetrics')
	const viewport = (metrics as { visualViewport?: { pageX?: number; pageY?: number; scale?: number } }).visualViewport
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
