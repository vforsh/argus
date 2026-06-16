import fs from 'node:fs/promises'
import type { ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, resolveArtifactPath } from '../artifacts.js'
import { createVisualCapturePlan, type VisualCaptureClip } from './visualCapture.js'

const SCREENSHOT_CDP_TIMEOUT_MS = 20_000
const SCREENSHOT_CDP_MAX_ATTEMPTS = 2

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
		const capturePlan = await createVisualCapturePlan(options.session, options.pageSession, request)

		const result = await captureScreenshot(capturePlan.session, {
			format,
			clip: capturePlan.clip,
		})

		await fs.writeFile(absolutePath, Buffer.from(result.data, 'base64'))
		return { ok: true, outFile: displayPath, clipped: result.clipped }
	}

	return { capture }
}

const captureScreenshot = async (session: CdpSessionHandle, options: { format: 'png'; clip?: VisualCaptureClip }): Promise<CaptureResult> => {
	let lastError: unknown

	for (let attempt = 1; attempt <= SCREENSHOT_CDP_MAX_ATTEMPTS; attempt += 1) {
		try {
			// Hidden Electron targets can occasionally stall on the first screenshot request.
			const payload = await session.sendAndWait(
				'Page.captureScreenshot',
				{
					format: options.format,
					clip: options.clip,
				},
				{ timeoutMs: SCREENSHOT_CDP_TIMEOUT_MS },
			)

			const response = payload as { data?: string }
			if (!response.data) {
				throw new Error('Failed to capture screenshot')
			}

			return { data: response.data, clipped: Boolean(options.clip) }
		} catch (error) {
			lastError = error
			if (!isScreenshotTimeout(error) || attempt === SCREENSHOT_CDP_MAX_ATTEMPTS) {
				throw error
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Failed to capture screenshot')
}

const isScreenshotTimeout = (error: unknown): boolean => error instanceof Error && error.message.startsWith('CDP request timed out after')
