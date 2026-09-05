import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type {
	RecordFormat,
	RecordRequest,
	RecordStartRequest,
	RecordStartResponse,
	RecordStatusSummary,
	RecordStopReason,
	RecordStopRequest,
	RecordStopResponse,
} from '@vforsh/argus-core'
import { RECORD_DEFAULT_MAX_DURATION_MS, RECORD_DEFAULT_POLL_INTERVAL_MS, RECORD_GIF_DEFAULT_FPS, RECORD_GIF_MAX_FPS } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { ensureArtifactsDir, ensureParentDir, moveArtifactFile, resolveArtifactPath } from '../artifacts.js'
import { createDeferred } from '../deferred.js'
import { formatFfmpegError, readFrameInfo, startFfmpeg, type FrameCodec } from './ffmpeg.js'
import { createVisualCapturePlan } from './visualCapture.js'
import { evaluateInPage } from './pageState.js'
import {
	armScreencast,
	assertClipIsVisible,
	clearRecordingTimers,
	flushFrames,
	pumpFrames,
	scrollSelectorIntoView,
	subscribeToScreencast,
	type RecordingState,
} from './recordingSession.js'

const DEFAULT_RECORD_FPS = 30
const DEFAULT_FRAME_QUALITY = 90

/**
 * How long to wait for Chrome's first screencast frame.
 *
 * Generous because the recorder now brings the page to the front first: the common cause of a
 * missing first frame is a backgrounded tab, and once that is handled the remaining causes
 * (a heavy first paint, a canvas warming up) deserve more than a couple of seconds.
 */
const FIRST_FRAME_TIMEOUT_MS = 5_000

/** Deadline for the encoder to finish after its input closes, so a wedged ffmpeg cannot hang a stop. */
const ENCODER_DRAIN_TIMEOUT_MS = 30_000

export type Recorder = {
	capture: (request: RecordRequest) => Promise<RecordStopResponse>
	start: (request: RecordStartRequest) => Promise<RecordStartResponse>
	stop: (request: RecordStopRequest) => Promise<RecordStopResponse>
	/** Live recording summary, or `null` when nothing is recording. */
	status: () => RecordStatusSummary | null
	onDetached: (reason?: string) => void
}

export const createRecorder = (options: {
	session: CdpSessionHandle
	pageSession?: CdpSessionHandle
	artifactsDir: string
	onRecordingStateChange?: (recording: boolean) => void
}): Recorder => {
	let active: RecordingState | null = null

	const start = async (request: RecordStartRequest): Promise<RecordStartResponse> => {
		if (active && active.state !== 'stopped') {
			throw new Error('Recording already active')
		}

		await ensureArtifactsDir(options.artifactsDir)
		const format = resolveRecordFormat(request)
		const fps = normalizeFps(request.fps, format)
		const sessionName = `record-${new Date().toISOString().replace(/[:.]/g, '-')}`
		const absolutePath = resolveArtifactPath(options.artifactsDir, request.outFile, `recordings/${sessionName}.${format}`)
		validateOutputPathFormat(absolutePath, format)
		await ensureParentDir(absolutePath)

		if (request.selector) {
			await scrollSelectorIntoView(options.session, request.selector)
		}

		const capturePlan = await createVisualCapturePlan(options.session, options.pageSession, request)
		if (capturePlan.clip) {
			assertClipIsVisible(capturePlan.clip, capturePlan.viewport, request.selector ? `Selector "${request.selector}"` : 'The requested clip')
		}

		const firstFrameDeferred = createDeferred<Buffer>()
		const state: RecordingState = {
			recordId: crypto.randomUUID(),
			sessionName,
			absolutePath: path.resolve(absolutePath),
			outFile: absolutePath,
			session: capturePlan.session,
			evalSession: options.session,
			removeFrameHandler: () => {},
			removeNavigationHandler: () => {},
			ffmpeg: null,
			frameCodec: resolveFrameCodec(request),
			quality: normalizeQuality(request.quality),
			firstFrame: firstFrameDeferred.promise,
			resolveFirstFrame: firstFrameDeferred.resolve,
			rejectFirstFrame: firstFrameDeferred.reject,
			firstFrameTimer: null,
			sampleTimer: null,
			maxDurationTimer: null,
			endTimer: null,
			untilTimer: null,
			latestFrame: null,
			pumpBlocked: false,
			frameCount: 0,
			startedAt: Date.now(),
			capturedDurationMs: null,
			fps,
			format,
			maxDurationMs: normalizeMaxDuration(request.maxDurationMs),
			clip: capturePlan.clip,
			viewport: capturePlan.viewport,
			navigations: 0,
			stopReason: 'requested',
			partial: false,
			encodeError: null,
			finalizePromise: null,
			finished: createDeferred<void>(),
			sizeBytes: 0,
			state: 'starting',
		}
		active = state

		try {
			await beginCapture(state)
			options.onRecordingStateChange?.(true)
			return {
				ok: true,
				recordId: state.recordId,
				sessionName,
				outFile: absolutePath,
				format,
				fps,
				clipped: Boolean(state.clip),
				maxDurationMs: state.maxDurationMs,
			}
		} catch (error) {
			active = null
			await cleanupFailedStart(state)
			throw normalizeStartError(error)
		}
	}

	/** Bring the page forward, arm the screencast, size the encoder from the first real frame. */
	const beginCapture = async (state: RecordingState): Promise<void> => {
		subscribeToScreencast(state)
		state.firstFrameTimer = setTimeout(() => {
			state.rejectFirstFrame(new Error('No screencast frames received. Make the page visible with `argus page show <id>` and try again.'))
		}, FIRST_FRAME_TIMEOUT_MS)

		// A backgrounded tab never paints, which is the single most common cause of an empty capture.
		await state.session.sendAndWait('Page.bringToFront', undefined, { timeoutMs: 2_000 }).catch(() => {})
		await armScreencast(state)

		const firstFrame = await state.firstFrame
		clearTimeout(state.firstFrameTimer)
		state.firstFrameTimer = null
		state.ffmpeg = await startFfmpeg({
			absolutePath: state.absolutePath,
			fps: state.fps,
			format: state.format,
			clip: state.clip,
			viewport: state.viewport,
			frame: readFrameInfo(firstFrame),
		})
		state.state = 'recording'
		state.startedAt = Date.now()
		pumpFrames(state)
		state.sampleTimer = setInterval(() => pumpFrames(state), Math.max(1, Math.round(1000 / state.fps)))
		state.maxDurationTimer = setTimeout(() => {
			void finalize(state, 'max-duration')
		}, state.maxDurationMs)
	}

	const capture = async (request: RecordRequest): Promise<RecordStopResponse> => {
		await start(request)
		const state = active
		if (!state) {
			throw new Error('Recording ended before it began')
		}

		scheduleCaptureEnd(state, request)
		await state.finished.promise
		return stop({})
	}

	/** Arm whichever end condition this capture asked for: a fixed window or a page predicate. */
	const scheduleCaptureEnd = (state: RecordingState, request: RecordRequest): void => {
		const { until } = request
		if (until != null) {
			const intervalMs = Math.max(10, request.pollIntervalMs ?? RECORD_DEFAULT_POLL_INTERVAL_MS)
			state.untilTimer = setInterval(createUntilPoller(state, until), intervalMs)
			return
		}

		state.endTimer = setTimeout(() => {
			void finalize(state, 'duration')
		}, request.durationMs ?? state.maxDurationMs)
	}

	/**
	 * Poll a page predicate, skipping ticks while a previous evaluation is still running.
	 *
	 * The in-flight guard is per poller rather than per recorder so a slow evaluation left over
	 * from one recording cannot suppress the first ticks of the next.
	 */
	const createUntilPoller = (state: RecordingState, expression: string): (() => void) => {
		let inFlight = false

		return () => {
			if (inFlight || state.state !== 'recording') {
				return
			}

			inFlight = true
			void evaluateInPage<unknown>(state.evalSession, `(${expression})`, { awaitPromise: true, timeoutMs: 5_000 })
				.then((value) => {
					if (value) {
						return finalize(state, 'until')
					}
				})
				.catch(() => {
					// A navigating or busy page throws; the condition is simply not met yet.
				})
				.finally(() => {
					inFlight = false
				})
		}
	}

	/**
	 * Shut the capture down exactly once, and make every caller wait for that one shutdown.
	 *
	 * Three independent things race to end a recording: the caller's `stop`, the duration/`until`
	 * timer, and CDP detaching underneath both. Returning early for the losers is not enough —
	 * `stop` would then move the output file while ffmpeg was still writing it — so they all await
	 * the same promise.
	 */
	const finalize = (state: RecordingState, reason: RecordStopReason): Promise<void> => {
		state.finalizePromise ??= runFinalize(state, reason)
		return state.finalizePromise
	}

	const runFinalize = async (state: RecordingState, reason: RecordStopReason): Promise<void> => {
		state.state = 'stopping'
		state.stopReason = reason
		// Only losing the page truncates a recording; every other reason is a bound being reached.
		state.partial = reason === 'detached'
		state.capturedDurationMs = Math.max(0, Date.now() - state.startedAt)
		clearRecordingTimers(state)
		state.removeFrameHandler()
		state.removeNavigationHandler()

		try {
			await state.session.sendAndWait('Page.stopScreencast', undefined, { timeoutMs: 5_000 }).catch(() => {})
			await flushFrames(state, state.capturedDurationMs)
			state.ffmpeg?.child.stdin.end()
			await withTimeout(state.ffmpeg?.completion, ENCODER_DRAIN_TIMEOUT_MS)
		} catch (error) {
			// A failed encode still leaves whatever ffmpeg wrote; report it as partial rather than
			// throwing away a repro clip the caller may already have watched being made.
			state.partial = true
			state.encodeError = error
		} finally {
			state.state = 'stopped'
			state.sizeBytes = await fileSize(state.absolutePath)
			options.onRecordingStateChange?.(false)
			state.finished.resolve()
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

		await finalize(state, 'requested')
		active = null
		if (state.encodeError && state.sizeBytes === 0) {
			throw state.encodeError
		}

		await resolveFinalPath(state, request.outFile)
		return buildStopResponse(state)
	}

	const status = (): RecordStatusSummary | null => {
		const state = active
		if (!state || state.state === 'stopped') {
			return null
		}

		return {
			recordId: state.recordId,
			sessionName: state.sessionName,
			outFile: state.outFile,
			format: state.format,
			fps: state.fps,
			clipped: Boolean(state.clip),
			startedAt: state.startedAt,
			elapsedMs: Math.max(0, Date.now() - state.startedAt),
			frameCount: state.frameCount,
			maxDurationMs: state.maxDurationMs,
			navigations: state.navigations,
		}
	}

	/**
	 * Close the encoder cleanly when the page goes away, instead of killing it.
	 *
	 * SIGTERM on an mp4 encode loses the moov atom, so every detached recording used to produce an
	 * unplayable file. Finalizing keeps the frames captured up to the detach and marks them partial.
	 */
	const onDetached = (reason?: string): void => {
		const state = active
		if (!state || state.state === 'stopped') {
			return
		}

		state.rejectFirstFrame(new Error(reason ?? 'CDP detached while recording'))
		void finalize(state, 'detached')
	}

	return { capture, start, stop, status, onDetached }

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

const withTimeout = async (promise: Promise<void> | undefined, timeoutMs: number): Promise<void> => {
	if (!promise) {
		return
	}

	let timer: NodeJS.Timeout | undefined
	try {
		await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`ffmpeg did not finish within ${timeoutMs}ms`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}

const fileSize = async (absolutePath: string): Promise<number> => {
	try {
		return (await fs.stat(absolutePath)).size
	} catch {
		return 0
	}
}

const cleanupFailedStart = async (state: RecordingState): Promise<void> => {
	clearRecordingTimers(state)
	state.removeFrameHandler()
	state.removeNavigationHandler()
	await state.session.sendAndWait('Page.stopScreencast', undefined, { timeoutMs: 5_000 }).catch(() => {})
	state.ffmpeg?.child.kill('SIGTERM')
	state.ffmpeg?.child.stdin.destroy()
	try {
		await fs.unlink(state.absolutePath)
	} catch {
		// Best effort: the encoder may not have created the file yet.
	}
}

const normalizeStartError = (error: unknown): unknown =>
	error instanceof Error && error.message.startsWith('spawn ffmpeg ENOENT') ? formatFfmpegError(error) : error

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
	stopReason: state.stopReason,
	partial: state.partial,
	navigations: state.navigations,
	sizeBytes: state.sizeBytes,
})

const normalizeFps = (fps: number | undefined, format: RecordFormat): number => {
	if (fps == null) {
		return format === 'gif' ? RECORD_GIF_DEFAULT_FPS : DEFAULT_RECORD_FPS
	}

	const rounded = Math.min(60, Math.max(1, Math.round(fps)))
	return format === 'gif' ? Math.min(RECORD_GIF_MAX_FPS, rounded) : rounded
}

const normalizeQuality = (quality: number | undefined): number =>
	quality == null ? DEFAULT_FRAME_QUALITY : Math.min(100, Math.max(1, Math.round(quality)))

const normalizeMaxDuration = (maxDurationMs: number | undefined): number =>
	maxDurationMs == null || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 ? RECORD_DEFAULT_MAX_DURATION_MS : maxDurationMs

/**
 * JPEG frames unless the caller explicitly wants lossless.
 *
 * PNG screencast frames cost several times more to encode and serialize in the renderer than JPEG,
 * and the output is re-encoded lossily anyway. GIF is the exception: its palette quantization
 * amplifies JPEG ringing on flat UI, so it keeps PNG frames.
 */
const resolveFrameCodec = (request: RecordStartRequest): FrameCodec =>
	resolveRecordFormat(request) === 'gif' && request.quality == null ? 'png' : 'jpeg'

const resolveRecordFormat = (request: RecordStartRequest): RecordFormat => request.format ?? inferRecordFormatFromPath(request.outFile) ?? 'mp4'

const inferRecordFormatFromPath = (outFile: string | undefined): RecordFormat | undefined => {
	const ext = path.extname(outFile?.trim() ?? '').toLowerCase()
	if (ext === '.mp4') return 'mp4'
	if (ext === '.webm') return 'webm'
	if (ext === '.gif') return 'gif'
	return undefined
}

const validateOutputPathFormat = (outFile: string, format: RecordFormat): void => {
	const ext = path.extname(outFile.trim()).toLowerCase()
	if (ext && ext !== '.mp4' && ext !== '.webm' && ext !== '.gif') {
		throw new Error('Recording output must use .mp4, .webm, or .gif when an extension is provided')
	}

	const inferred = inferRecordFormatFromPath(outFile)
	if (inferred && inferred !== format) {
		throw new Error(`Output extension .${inferred} does not match recording format ${format}`)
	}
}
