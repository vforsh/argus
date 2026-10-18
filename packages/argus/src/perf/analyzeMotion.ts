import { decodeJpegLuma } from './jpegLuma.js'
import { correlateFrames, LOW_CONFIDENCE_PEAK, planCorrelation, prepareFrame, type CorrelationGeometry, type PreparedFrame } from './phaseCorrelation.js'
import type { MotionSection } from './runResult.js'
import { coefficientOfVariation, median, round, sparkline } from './stats.js'
import type { TraceScreenshot, TraceWindow } from './traceAnalysis.js'

/** A step above this multiple of the median moving step counts as a double step (a frame's update skipped). */
const DOUBLE_STEP_RATIO = 1.7
const MIN_ZERO_STEP_PX = 0.5

export type MotionOptions = {
	/** Page viewport in CSS px, to convert screenshot pixels to CSS pixels. */
	viewport: { width: number; height: number }
	/** Region to measure, in CSS px; default: whole viewport. */
	clip?: { x: number; y: number; width: number; height: number }
	/** Only frames presented inside this window count (trace µs). One frame before it is kept as reference. */
	window?: TraceWindow | null
	/** When input was active (trace µs); zero steps outside it are not judder. Default: the whole window. */
	inputActive?: TraceWindow | null
}

/**
 * On-screen displacement per presented frame, from the trace's per-frame screenshots.
 *
 * App-agnostic judder metric: a frame that reaches the screen without the content moving while the
 * user is still dragging is exactly what "feels janky" means, whatever rAF reports. Zero steps are
 * counted only between the first and last moving frame of the input window, so the latency before the
 * first update lands is not mistaken for judder.
 */
export const analyzeMotion = (screenshots: TraceScreenshot[], options: MotionOptions): MotionSection | null => {
	const ordered = dedupeBySequence([...screenshots].sort((a, b) => a.ts - b.ts))
	const window = options.window
	const firstInside = window ? ordered.findIndex((shot) => shot.ts >= window.start) : 0
	if (firstInside === -1) return null
	let lastInside = ordered.length - 1
	while (window && lastInside >= 0 && ordered[lastInside]!.ts > window.end) lastInside -= 1
	const frames = ordered.slice(Math.max(0, firstInside - 1), lastInside + 1)
	if (frames.length < 2) return null

	let geometry: CorrelationGeometry | null = null
	let scale = 1
	let screenshotSize: { width: number; height: number } | undefined
	let previous: PreparedFrame | null = null
	/** Null where the correlation peak was too weak to trust: the step is unknown, not zero. */
	const vectors: ([number, number] | null)[] = []
	const times: number[] = []

	for (const shot of frames) {
		const image = decodeJpegLuma(Buffer.from(shot.snapshot, 'base64'))
		if (!geometry) {
			screenshotSize = { width: image.width, height: image.height }
			scale = image.width / options.viewport.width
			const clip = options.clip
			geometry = planCorrelation(image, clip && { x: clip.x * scale, y: clip.y * scale, width: clip.width * scale, height: clip.height * scale })
		}
		const prepared = prepareFrame(image, geometry)
		if (previous) {
			const shift = correlateFrames(previous, prepared, geometry)
			vectors.push(shift.peak < LOW_CONFIDENCE_PEAK ? null : [round(shift.dx / scale), round(shift.dy / scale)])
			times.push(shot.ts)
		}
		previous = prepared
	}

	const steps = vectors.map((vector) => (vector ? round(Math.hypot(vector[0], vector[1])) : null))
	const measured = steps.filter((step): step is number => step != null)
	const zeroThreshold = Math.max(MIN_ZERO_STEP_PX, 0.15 * median(measured.filter((step) => step > MIN_ZERO_STEP_PX)))
	const isMoving = (step: number | null): step is number => step != null && step >= zeroThreshold

	// Judder window: from the first moving frame (input latency before it is not judder) to the end of
	// input. Input, not the last observed motion, owns the end, so a freeze while the drag continues
	// counts as zero steps and a trailing stall.
	const active = options.inputActive ?? window ?? null
	const firstMoving = steps.findIndex((step, index) => isMoving(step) && (!active || times[index]! >= active.start))
	let lastActive = times.length - 1
	while (active && lastActive >= 0 && times[lastActive]! > active.end) lastActive -= 1
	let lastMoving = steps.length - 1
	while (lastMoving >= 0 && !isMoving(steps[lastMoving]!)) lastMoving -= 1
	const end = Math.max(lastActive, lastMoving)
	const range = firstMoving === -1 ? [] : steps.slice(firstMoving, end + 1).map((step, offset) => ({ step, index: firstMoving + offset }))
	const trusted = range.flatMap(({ step }) => (step == null ? [] : [step]))
	const rangeMedian = median(trusted.filter((step) => step >= zeroThreshold))

	let longestStallMs = 0
	let lastMovingTs = firstMoving === -1 ? null : (times[firstMoving - 1] ?? times[firstMoving]!)
	for (const { step, index } of range) {
		if (!isMoving(step)) continue
		longestStallMs = Math.max(longestStallMs, (times[index]! - lastMovingTs!) / 1000)
		lastMovingTs = times[index]!
	}
	if (range.length > 0 && lastMovingTs != null) longestStallMs = Math.max(longestStallMs, (times[range.at(-1)!.index]! - lastMovingTs) / 1000)

	const spanUs = times.length > 1 ? times.at(-1)! - (times[0]! - (times[1]! - times[0]!)) : 0
	return {
		frames: steps.length,
		presentedFps: spanUs > 0 ? round((steps.length * 1e6) / spanUs, 1) : 0,
		steps,
		vectors,
		zeroStepFrames: trusted.filter((step) => step < zeroThreshold).length,
		doubleSteps: trusted.filter((step) => rangeMedian > 0 && step > DOUBLE_STEP_RATIO * rangeMedian).length,
		stepCv: round(coefficientOfVariation(trusted), 3),
		medianStep: round(rangeMedian),
		longestStallMs: round(longestStallMs, 1),
		totalDisplacement: round(measured.reduce((sum, step) => sum + step, 0), 1),
		lowConfidenceFrames: steps.length - measured.length,
		sparkline: sparkline(range.map(({ step }) => step ?? 0)),
		screenshotSize,
		clip: options.clip,
	}
}

/** The screenshot category can log one frame twice; keep the first per frame sequence. */
const dedupeBySequence = (shots: TraceScreenshot[]): TraceScreenshot[] => {
	const seen = new Set<number>()
	return shots.filter((shot) => {
		if (shot.frameSequence == null) return true
		if (seen.has(shot.frameSequence)) return false
		seen.add(shot.frameSequence)
		return true
	})
}
