import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { RecordRequest, RecordStartRequest, RecordStartResponse, RecordStopRequest, RecordStopResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, resolveArtifactPath } from '../artifacts.js'
import { createVisualCapturePlan, type VisualCaptureClip, type VisualCaptureViewport } from './visualCapture.js'

const DEFAULT_RECORD_FPS = 30
const FIRST_FRAME_TIMEOUT_MS = 2_000

type PngSize = { width: number; height: number }
type FfmpegChild = ChildProcessByStdio<Writable, null, Readable>
type FfmpegProcess = {
	child: FfmpegChild
	completion: Promise<void>
}

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
		const fps = normalizeFps(request.fps)
		const recordId = crypto.randomUUID()
		const sessionName = `record-${new Date().toISOString().replace(/[:.]/g, '-')}`
		const defaultName = `recordings/${sessionName}.webm`
		const { absolutePath, displayPath } = resolveArtifactPath(options.artifactsDir, request.outFile, defaultName)
		await ensureParentDir(absolutePath)

		const capturePlan = await createVisualCapturePlan(options.session, options.pageSession, request)
		const firstFrameDeferred = createDeferred<Buffer>()
		const state: RecordingState = {
			recordId,
			sessionName,
			absolutePath: path.resolve(absolutePath),
			outFile: displayPath,
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
				outFile: displayPath,
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

		const { absolutePath, displayPath } = resolveArtifactPath(options.artifactsDir, outFile, `recordings/${state.sessionName}.webm`)
		if (path.resolve(absolutePath) === state.absolutePath) {
			return
		}

		await ensureParentDir(absolutePath)
		try {
			await fs.rename(state.absolutePath, absolutePath)
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException
			if (nodeError.code !== 'EXDEV') {
				throw error
			}

			await fs.copyFile(state.absolutePath, absolutePath)
			await fs.unlink(state.absolutePath)
		}

		state.absolutePath = path.resolve(absolutePath)
		state.outFile = displayPath
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

const startFfmpeg = async (options: {
	absolutePath: string
	fps: number
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frameSize: PngSize
}): Promise<FfmpegProcess> => {
	const ffmpeg = process.env.ARGUS_FFMPEG?.trim() || 'ffmpeg'
	const filter = buildVideoFilter(options)
	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'image2pipe',
		'-framerate',
		String(options.fps),
		'-vcodec',
		'png',
		'-i',
		'pipe:0',
		'-an',
		'-vf',
		filter,
		'-c:v',
		'libvpx',
		'-deadline',
		'realtime',
		'-cpu-used',
		'5',
		'-b:v',
		'1M',
		'-y',
		options.absolutePath,
	]
	const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
	let stderr = ''
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-4000)
	})

	const completion = new Promise<void>((resolve, reject) => {
		child.once('error', (error) => reject(formatFfmpegError(error)))
		child.once('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(new Error(`ffmpeg failed with exit code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`))
		})
	})
	void completion.catch(() => {})

	await new Promise<void>((resolve, reject) => {
		child.once('spawn', () => resolve())
		child.once('error', (error) => reject(formatFfmpegError(error)))
	})

	return { child, completion }
}

const buildVideoFilter = (options: {
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	frameSize: PngSize
}): string => {
	if (!options.clip) {
		return 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'
	}
	if (!options.viewport) {
		throw new Error('Unable to compute viewport size for recording crop')
	}

	const ratioX = options.frameSize.width / options.viewport.width
	const ratioY = options.frameSize.height / options.viewport.height
	const x = clampEven(options.clip.x * ratioX, 0, options.frameSize.width - 2)
	const y = clampEven(options.clip.y * ratioY, 0, options.frameSize.height - 2)
	const width = clampEven(options.clip.width * ratioX, 2, options.frameSize.width - x)
	const height = clampEven(options.clip.height * ratioY, 2, options.frameSize.height - y)
	return `crop=${width}:${height}:${x}:${y},format=yuv420p`
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

const readPngSize = (buffer: Buffer): PngSize => {
	if (
		buffer.length < 24 ||
		buffer[0] !== 0x89 ||
		buffer[1] !== 0x50 ||
		buffer[2] !== 0x4e ||
		buffer[3] !== 0x47 ||
		buffer[4] !== 0x0d ||
		buffer[5] !== 0x0a ||
		buffer[6] !== 0x1a ||
		buffer[7] !== 0x0a
	) {
		throw new Error('Expected PNG screencast frame')
	}

	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	}
}

const clampEven = (value: number, min: number, max: number): number => {
	const clamped = Math.min(max, Math.max(min, Math.floor(value)))
	return Math.max(2, Math.floor(clamped / 2) * 2)
}

const formatFfmpegError = (error: unknown): Error => {
	const nodeError = error as NodeJS.ErrnoException
	if (nodeError.code === 'ENOENT') {
		return new Error('ffmpeg not found. Install ffmpeg or pass ARGUS_FFMPEG=/path/to/ffmpeg.')
	}
	return error instanceof Error ? error : new Error(String(error))
}

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } => {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve
		reject = nextReject
	})
	return { promise, resolve, reject }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
