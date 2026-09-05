import type { RecordFormat, RecordStopReason } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import type { Deferred } from '../deferred.js'
import type { FfmpegProcess, FrameCodec } from './ffmpeg.js'
import type { VisualCaptureClip, VisualCaptureViewport } from './visualCapture.js'
import { tryEvaluateInPage } from './pageState.js'
import { delay } from '@vforsh/argus-core'

/**
 * Screencast frame plumbing for {@link createRecorder}: the live recording's state, the wall-clock
 * frame pump that feeds ffmpeg, and the screencast (re-)arming that survives navigation.
 *
 * Separate from `recording.ts` because the lifecycle (start/stop/finalize/status) and the pacing
 * are independently tricky and neither wants to be read through the other.
 */

/** Everything one in-flight recording needs. Mutable by design — the pump runs on timers. */
export type RecordingState = {
	recordId: string
	sessionName: string
	absolutePath: string
	outFile: string
	/** Page-scoped session that produces pixels. For an iframe target this is the top-level page. */
	session: CdpSessionHandle
	/** Selected target, where an `until` expression is evaluated. Same session for page targets. */
	evalSession: CdpSessionHandle
	removeFrameHandler: () => void
	removeNavigationHandler: () => void
	ffmpeg: FfmpegProcess | null
	frameCodec: FrameCodec
	quality: number
	firstFrame: Promise<Buffer>
	resolveFirstFrame: (frame: Buffer) => void
	rejectFirstFrame: (error: Error) => void
	firstFrameTimer: NodeJS.Timeout | null
	sampleTimer: NodeJS.Timeout | null
	/** Backstop that stops an open-ended recording. Always armed. */
	maxDurationTimer: NodeJS.Timeout | null
	/** The requested end condition for a fixed-duration capture. */
	endTimer: NodeJS.Timeout | null
	untilTimer: NodeJS.Timeout | null
	latestFrame: Buffer | null
	pumpBlocked: boolean
	/** Frames handed to the encoder so far. */
	frameCount: number
	startedAt: number
	capturedDurationMs: number | null
	fps: number
	format: RecordFormat
	maxDurationMs: number
	clip: VisualCaptureClip | undefined
	viewport: VisualCaptureViewport | undefined
	navigations: number
	stopReason: RecordStopReason
	partial: boolean
	/** Encoder failure kept for the stop response; a partial file still beats an exception. */
	encodeError: unknown
	/** In-flight shutdown, so every racing caller awaits the same encode instead of racing it. */
	finalizePromise: Promise<void> | null
	/** Settled once the encoder has finished, whichever end condition got there first. */
	finished: Deferred<void>
	sizeBytes: number
	state: 'starting' | 'recording' | 'stopping' | 'stopped'
}

/**
 * Scroll a selector target into view before the capture plan measures it.
 *
 * A screencast only ever carries the visible viewport, so an element below the fold has no pixels
 * to crop. `Page.captureScreenshot` has no such limit, which is why `screenshot --selector` works
 * on an off-screen element and `record --selector` cannot — it used to silently emit a 2px sliver.
 *
 * Best-effort: a selector that matches nothing is reported by the capture plan, which produces a
 * better message than anything this could throw.
 */
export const scrollSelectorIntoView = async (session: CdpSessionHandle, selector: string): Promise<void> => {
	await tryEvaluateInPage(
		session,
		`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })`,
		{ timeoutMs: 5_000 },
	)
	// Let scroll-linked layout settle before the box model is read.
	await delay(100)
}

/** Smallest visible edge, in CSS pixels, that still makes a recordable region. */
const MIN_VISIBLE_EXTENT_PX = 2

/**
 * Reject a crop the screencast cannot actually deliver.
 *
 * The encoder clamps an out-of-frame rectangle to the nearest legal one, so an off-screen target
 * used to encode cleanly as a 2-pixel sliver and only look wrong when someone played the file.
 *
 * @throws {Error} When the crop lies (almost) entirely outside the captured viewport.
 */
export const assertClipIsVisible = (clip: VisualCaptureClip, viewport: VisualCaptureViewport | undefined, subject: string): void => {
	if (!viewport) {
		return
	}

	const visibleWidth = Math.min(clip.x + clip.width, viewport.width) - Math.max(clip.x, 0)
	const visibleHeight = Math.min(clip.y + clip.height, viewport.height) - Math.max(clip.y, 0)
	if (visibleWidth >= MIN_VISIBLE_EXTENT_PX && visibleHeight >= MIN_VISIBLE_EXTENT_PX) {
		return
	}

	throw new Error(
		`${subject} is outside the visible viewport (${Math.round(clip.width)}x${Math.round(clip.height)} at ${Math.round(clip.x)},${Math.round(clip.y)}; viewport is ${Math.round(viewport.width)}x${Math.round(viewport.height)}). ` +
			'Recordings capture only what the page is showing — scroll the target into view, or record the viewport and crop later.',
	)
}

/**
 * Start (or restart) Chrome's screencast for this recording.
 *
 * Called once at start and again after every top-frame navigation: Chrome tears the screencast
 * down on a cross-process navigation and never says so, which used to leave the encoder repeating
 * the last pre-navigation frame for the rest of the capture.
 */
export const armScreencast = async (state: RecordingState): Promise<void> => {
	await state.session.sendAndWait('Page.startScreencast', {
		format: state.frameCodec,
		quality: state.frameCodec === 'jpeg' ? state.quality : undefined,
		everyNthFrame: 1,
	})
}

/** Subscribe to screencast frames and top-frame navigations for the lifetime of the recording. */
export const subscribeToScreencast = (state: RecordingState): void => {
	state.removeFrameHandler = state.session.onEvent('Page.screencastFrame', (params) => {
		handleScreencastFrame(state, params)
	})
	state.removeNavigationHandler = state.session.onEvent('Page.frameNavigated', (params) => {
		// Subframe navigations do not disturb the screencast; only the top frame does.
		if (params.frame?.parentId) {
			return
		}
		if (state.state !== 'recording' && state.state !== 'starting') {
			return
		}

		state.navigations += 1
		void armScreencast(state).catch(() => {
			// The renderer may still be swapping; the next navigation or stop reports the gap.
		})
	})
}

const handleScreencastFrame = (state: RecordingState, params: { data?: string; sessionId?: number }): void => {
	if (typeof params.data !== 'string') {
		return
	}

	const frame = Buffer.from(params.data, 'base64')
	state.latestFrame = frame
	state.resolveFirstFrame(frame)

	if (typeof params.sessionId === 'number') {
		void state.session.sendAndWait('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
	}
}

/**
 * Frames wall-clock time says should exist by now.
 *
 * Recomputed from elapsed time rather than incremented once per timer tick: `setInterval` drifts
 * under load and silently under-delivers, so a counter produced files whose duration did not match
 * the capture window — a 5s recording that played back as 3.4s.
 */
const targetFrameCount = (state: RecordingState, elapsedMs: number): number => Math.max(1, Math.round((elapsedMs / 1000) * state.fps))

/**
 * Write frames until the encoder has `target` of them.
 *
 * The deficit left by backpressure is never dropped — it is paid down over successive calls — but
 * one call writes at most a second's worth, so a stalled encoder cannot make us buffer an unbounded
 * burst of full frames in its stdin.
 */
const writeFramesUpTo = (state: RecordingState, target: number): void => {
	if (!state.latestFrame || !state.ffmpeg || state.pumpBlocked || state.ffmpeg.child.stdin.destroyed) {
		return
	}

	let budget = Math.max(1, state.fps)
	while (state.frameCount < target && budget > 0) {
		budget -= 1
		state.frameCount += 1
		const ready = state.ffmpeg.child.stdin.write(state.latestFrame)
		if (!ready) {
			state.pumpBlocked = true
			state.ffmpeg.child.stdin.once('drain', () => {
				state.pumpBlocked = false
				writeFramesUpTo(state, target)
			})
			return
		}
	}
}

/** Bring the encoder up to date with how long the recording has been running. */
export const pumpFrames = (state: RecordingState): void => {
	writeFramesUpTo(state, targetFrameCount(state, Math.max(0, Date.now() - state.startedAt)))
}

/** Write the frames the final capture window still owes, then wait for the encoder to drain them. */
export const flushFrames = async (state: RecordingState, elapsedMs: number): Promise<void> => {
	const target = targetFrameCount(state, elapsedMs)
	writeFramesUpTo(state, target)

	while (state.frameCount < target || state.pumpBlocked) {
		if (!state.ffmpeg || state.ffmpeg.child.stdin.destroyed) {
			return
		}
		await delay(10)
		writeFramesUpTo(state, target)
	}
}

/** Clear every timer the recording owns. Safe to call more than once. */
export const clearRecordingTimers = (state: RecordingState): void => {
	if (state.firstFrameTimer) {
		clearTimeout(state.firstFrameTimer)
		state.firstFrameTimer = null
	}
	if (state.sampleTimer) {
		clearInterval(state.sampleTimer)
		state.sampleTimer = null
	}
	if (state.maxDurationTimer) {
		clearTimeout(state.maxDurationTimer)
		state.maxDurationTimer = null
	}
	if (state.endTimer) {
		clearTimeout(state.endTimer)
		state.endTimer = null
	}
	if (state.untilTimer) {
		clearInterval(state.untilTimer)
		state.untilTimer = null
	}
}
