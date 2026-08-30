import path from 'node:path'
import crypto from 'node:crypto'
import type { RecordFormat, RecordRequest, RecordStartRequest, RecordStartResponse, RecordStopRequest, RecordStopResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import fs from 'node:fs/promises'
import { ensureArtifactsDir, ensureParentDir, moveArtifactFile, resolveArtifactPath } from '../artifacts.js'
import { createDeferred } from '../deferred.js'
import { formatFfmpegError, readPngSize, startFfmpeg, type FfmpegProcess } from './ffmpeg.js'
import { createVisualCapturePlan, type VisualCaptureClip, type VisualCaptureViewport } from './visualCapture.js'
import { delay } from '@vforsh/argus-core'

const DEFAULT_RECORD_FPS = 30
const FIRST_FRAME_TIMEOUT_MS = 2_000

type RecordingState = {
	recordId: string
	sessionName: string
	absolutePath: string
	outFile: string
	session: CdpSessionHandle
	removeFrameHandler: () => void
	ffmpeg: FfmpegProcess | null
	firstFrame: Promise<Buffer>
	resolveFirstFrame: (frame: Buffer) => void
	rejectFirstFrame: (error: Error) => void
	firstFrameTimer: NodeJS.Timeout
	sampleTimer: NodeJS.Timeout | null
	latestFrame: Buffer | null
	pendingFrameCount: number
	pumpBlocked: boolean
	frameCount: number
	startedAt: number
	capturedDurationMs: number | null
	fps: number
	format: RecordFormat
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	state: 'starting' | 'recording' | 'stopping'
}

export type Recorder = {
	capture: (request: RecordRequest) => Promise<RecordStopResponse>
	start: (request: RecordStartRequest) => Promise<RecordStartResponse>
	stop: (request: RecordStopRequest) => Promise<RecordStopResponse>
	onDetached: (reason?: string) => void
}

export const createRecorder = (options: {
	session: CdpSessionHandle
	pageSession?: CdpSessionHandle
	artifactsDir: string
	onRecordingStateChange?: (recording: boolean) => void
}): Recorder => {
	let active: RecordingState | null = null

	const capture = async (request: RecordRequest): Promise<RecordStopResponse> => {
		await start(request)
		await delay(request.durationMs)
		return stop({})
	}

	const start = async (request: RecordStartRequest): Promise<RecordStartResponse> => {
		if (active) {
			throw new Error('Recording already active')
		}

		await ensureArtifactsDir(options.artifactsDir)
		const format = resolveRecordFormat(request)
		const fps = normalizeFps(request.fps)
		const recordId = crypto.randomUUID()
		const sessionName = `record-${new Date().toISOString().replace(/[:.]/g, '-')}`
		const defaultName = `recordings/${sessionName}.${format}`
		const absolutePath = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)
		validateOutputPathFormat(absolutePath, format)
		await ensureParentDir(absolutePath)

		const capturePlan = await createVisualCapturePlan(options.session, options.pageSession, request)
		const firstFrameDeferred = createDeferred<Buffer>()
		const state: RecordingState = {
			recordId,
			sessionName,
			absolutePath: path.resolve(absolutePath),
			outFile: absolutePath,
			session: capturePlan.session,
			removeFrameHandler: () => {},
			ffmpeg: null,
			firstFrame: firstFrameDeferred.promise,
			resolveFirstFrame: firstFrameDeferred.resolve,
			rejectFirstFrame: firstFrameDeferred.reject,
			firstFrameTimer: setTimeout(() => {
				firstFrameDeferred.reject(
					new Error('No screencast frames received. Make the page visible with `argus page show <id>` and try again.'),
				)
			}, FIRST_FRAME_TIMEOUT_MS),
			sampleTimer: null,
			latestFrame: null,
			pendingFrameCount: 0,
			pumpBlocked: false,
			frameCount: 0,
			startedAt: Date.now(),
			capturedDurationMs: null,
			fps,
			format,
			clip: capturePlan.clip,
			viewport: capturePlan.viewport,
			state: 'starting',
		}
		active = state

		try {
			state.removeFrameHandler = state.session.onEvent('Page.screencastFrame', (params) => {
				handleScreencastFrame(state, params)
			})
			await state.session.sendAndWait('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
			const firstFrame = await state.firstFrame
			clearTimeout(state.firstFrameTimer)
			const frameSize = readPngSize(firstFrame)
			state.ffmpeg = await startFfmpeg({
				absolutePath: state.absolutePath,
				fps,
				format,
				clip: state.clip,
				viewport: state.viewport,
				frameSize,
			})
			state.state = 'recording'
			state.startedAt = Date.now()
			queueFrameSample(state)
			state.sampleTimer = setInterval(() => queueFrameSample(state), Math.round(1000 / fps))
			options.onRecordingStateChange?.(true)
			return {
				ok: true,
				recordId,
				sessionName,
				outFile: absolutePath,
				format,
				fps,
				clipped: Boolean(state.clip),
			}
		} catch (error) {
			active = null
			await cleanupFailedStart(state, error)
			throw error
		}
	}

	const stop = async (request: RecordStopRequest): Promise<RecordStopResponse> => {
		const state = active
		if (!state) {
			throw new Error('No active recording to stop')
		}
		if (request.recordId && request.recordId !== state.recordId) {
			throw new Error('Record id does not match active recording')
		}
		if (state.state === 'stopping') {
			await state.ffmpeg?.completion
			await resolveFinalPath(state, request.outFile)
			return buildStopResponse(state)
		}

		state.state = 'stopping'
		clearRecordingTimers(state)
		state.removeFrameHandler()
		state.capturedDurationMs = Math.max(0, Date.now() - state.startedAt)
		try {
			await state.session.sendAndWait('Page.stopScreencast', {}, { timeoutMs: 5_000 }).catch(() => {})
			queueMissingDurationFrames(state)
			await flushQueuedFrames(state)
			state.ffmpeg?.child.stdin.end()
			await state.ffmpeg?.completion
			await resolveFinalPath(state, request.outFile)
			return buildStopResponse(state)
		} finally {
			if (active === state) {
				active = null
			}
			options.onRecordingStateChange?.(false)
		}
	}

	const onDetached = (reason?: string): void => {
		const state = active
		if (!state) {
			return
		}
		active = null
		clearRecordingTimers(state)
		state.removeFrameHandler()
		state.rejectFirstFrame(new Error(reason ?? 'CDP detached while recording'))
		state.ffmpeg?.child.kill('SIGTERM')
		options.onRecordingStateChange?.(false)
	}

	return { capture, start, stop, onDetached }

	async function resolveFinalPath(state: RecordingState, outFile: string | undefined): Promise<void> {
		if (!outFile?.trim()) {
			return
		}

		const absolutePath = resolveArtifactPath(options.artifactsDir, outFile, `recordings/${state.sessionName}.${state.format}`)
		validateOutputPathFormat(absolutePath, state.format)
		if (path.resolve(absolutePath) === state.absolutePath) {
			return
		}

		await moveArtifactFile(state.absolutePath, absolutePath)

		state.absolutePath = path.resolve(absolutePath)
		state.outFile = absolutePath
	}
}

const handleScreencastFrame = (state: RecordingState, params: unknown): void => {
	const payload = params as { data?: unknown; sessionId?: unknown }
	if (typeof payload.data !== 'string') {
		return
	}

	const frame = Buffer.from(payload.data, 'base64')
	state.latestFrame = frame
	state.resolveFirstFrame(frame)

	if (typeof payload.sessionId === 'number') {
		void state.session.sendAndWait('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {})
	}
}

const queueFrameSample = (state: RecordingState): void => {
	if (!state.latestFrame || state.state !== 'recording') {
		return
	}

	state.pendingFrameCount += 1
	pumpQueuedFrames(state)
}

const queueMissingDurationFrames = (state: RecordingState): void => {
	if (!state.latestFrame) {
		return
	}

	const elapsedMs = state.capturedDurationMs ?? Math.max(0, Date.now() - state.startedAt)
	const targetFrameCount = Math.max(1, Math.round((elapsedMs / 1000) * state.fps))
	const queuedOrWritten = state.frameCount + state.pendingFrameCount
	if (queuedOrWritten < targetFrameCount) {
		state.pendingFrameCount += targetFrameCount - queuedOrWritten
	}
}

const flushQueuedFrames = async (state: RecordingState): Promise<void> => {
	pumpQueuedFrames(state)
	while (state.pendingFrameCount > 0 || state.pumpBlocked) {
		if (!state.ffmpeg || state.ffmpeg.child.stdin.destroyed) {
			return
		}
		await delay(10)
		pumpQueuedFrames(state)
	}
}

const pumpQueuedFrames = (state: RecordingState): void => {
	if (!state.latestFrame || !state.ffmpeg || state.pumpBlocked || state.ffmpeg.child.stdin.destroyed) {
		return
	}

	while (state.pendingFrameCount > 0) {
		state.pendingFrameCount -= 1
		state.frameCount += 1
		const ready = state.ffmpeg.child.stdin.write(state.latestFrame)
		if (!ready) {
			state.pumpBlocked = true
			state.ffmpeg.child.stdin.once('drain', () => {
				state.pumpBlocked = false
				pumpQueuedFrames(state)
			})
			return
		}
	}
}

const cleanupFailedStart = async (state: RecordingState, error: unknown): Promise<void> => {
	clearRecordingTimers(state)
	state.removeFrameHandler()
	await state.session.sendAndWait('Page.stopScreencast', {}, { timeoutMs: 5_000 }).catch(() => {})
	state.ffmpeg?.child.kill('SIGTERM')
	state.ffmpeg?.child.stdin.destroy()
	try {
		await fs.unlink(state.absolutePath)
	} catch {
		// Best effort: the encoder may not have created the file yet.
	}
	if (error instanceof Error && error.message.startsWith('spawn ffmpeg ENOENT')) {
		throw formatFfmpegError(error)
	}
}

const clearRecordingTimers = (state: RecordingState): void => {
	clearTimeout(state.firstFrameTimer)
	if (state.sampleTimer) {
		clearInterval(state.sampleTimer)
		state.sampleTimer = null
	}
}

const buildStopResponse = (state: RecordingState): RecordStopResponse => ({
	ok: true,
	recordId: state.recordId,
	sessionName: state.sessionName,
	outFile: state.outFile,
	format: state.format,
	frameCount: state.frameCount,
	durationMs: state.capturedDurationMs ?? Math.max(0, Date.now() - state.startedAt),
	fps: state.fps,
	clipped: Boolean(state.clip),
})

const normalizeFps = (fps: number | undefined): number => {
	if (fps == null) {
		return DEFAULT_RECORD_FPS
	}
	return Math.min(60, Math.max(1, Math.round(fps)))
}

const resolveRecordFormat = (request: RecordStartRequest): RecordFormat => request.format ?? inferRecordFormatFromPath(request.outFile) ?? 'mp4'

const inferRecordFormatFromPath = (outFile: string | undefined): RecordFormat | undefined => {
	const ext = path.extname(outFile?.trim() ?? '').toLowerCase()
	if (ext === '.mp4') return 'mp4'
	if (ext === '.webm') return 'webm'
	return undefined
}

const validateOutputPathFormat = (outFile: string, format: RecordFormat): void => {
	const ext = path.extname(outFile.trim()).toLowerCase()
	if (ext && ext !== '.mp4' && ext !== '.webm') {
		throw new Error('Recording output must use .mp4 or .webm when an extension is provided')
	}

	const inferred = inferRecordFormatFromPath(outFile)
	if (inferred && inferred !== format) {
		throw new Error(`Output extension .${inferred} does not match recording format ${format}`)
	}
}

