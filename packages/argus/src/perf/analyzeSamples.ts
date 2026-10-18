import type { RecorderData } from './pageRecorder.js'
import type { InputSection, LongFramesSection, PerfSamples, ProbeSection, RafSection, RecordedInputEvent } from './runResult.js'
import { coefficientOfVariation, distribution, median, round } from './stats.js'

const MOVE_TYPES = new Set(['pointermove', 'wheel'])

/**
 * Move/wheel DOM events that make up the gesture. When any move carries a pressed button, it is a
 * drag and button-less moves (the pointer travelling to the start point) are not part of it.
 */
export const gestureMoves = (inputs: readonly RecordedInputEvent[]): RecordedInputEvent[] => {
	const moves = inputs.filter((event) => !event.raw && MOVE_TYPES.has(event.type))
	const isDrag = (event: RecordedInputEvent): boolean => event.type === 'pointermove' && (event.buttons ?? 0) !== 0
	return moves.some(isDrag) ? moves.filter((event) => isDrag(event) || event.type === 'wheel') : moves
}
const DOUBLE_STEP_RATIO = 1.7
const GAP_MS = 25

/** rAF cadence: frame count, FPS, interval distribution and every interval over 20 ms. */
export const analyzeRaf = (data: RecorderData): RafSection => {
	const intervals = data.raf.slice(1).map((ts, index) => ts - data.raf[index]!)
	const spanMs = data.raf.length > 1 ? data.raf.at(-1)! - data.raf[0]! : 0
	const origin = data.startedAt ?? data.raf[0] ?? 0
	return {
		frames: data.raf.length,
		fps: spanMs > 0 ? round(((data.raf.length - 1) * 1000) / spanMs, 1) : 0,
		interval: distribution(intervals),
		over20ms: intervals.flatMap((interval, index) => (interval > 20 ? [[round(data.raf[index]! - origin, 1), round(interval, 1)] as [number, number]] : [])),
	}
}

/**
 * Delivered input: DOM event cadence, gaps, and how many events/samples land in each rAF frame
 * while input is active. The per-frame histogram is the number that exposes an embedded webview
 * delivering 30 Hz input to a 60 Hz page, or a replay that arrives in bursts.
 */
export const analyzeInput = (data: RecorderData): InputSection => {
	const dom = data.inputs.filter((event) => !event.raw)
	const moves = gestureMoves(data.inputs)
	const drag = moves.some((move) => (move.buttons ?? 0) !== 0)
	const raw = data.inputs.filter((event) => event.raw && (!drag || (event.buttons ?? 0) !== 0))
	const byType: Record<string, number> = {}
	for (const event of dom) byType[event.type] = (byType[event.type] ?? 0) + 1

	const intervals = moves.slice(1).map((event, index) => event.t - moves[index]!.t)
	const activeStart = moves[0]?.t ?? 0
	const activeEnd = moves.at(-1)?.t ?? 0
	const activeMs = Math.max(0, activeEnd - activeStart)
	const samples = raw.length > 0 ? raw : moves
	const sampleCount = raw.length > 0 ? raw.length : moves.reduce((sum, event) => sum + (event.coalesced ?? 1), 0)

	const eventsPerFrame: [number, number, number] = [0, 0, 0]
	const samplesPerFrame = [0, 0, 0, 0, 0, 0]
	let moveIndex = 0
	let sampleIndex = 0
	for (let i = 1; i < data.raf.length; i++) {
		const frameStart = data.raf[i - 1]!
		const frameEnd = data.raf[i]!
		while (moveIndex < moves.length && moves[moveIndex]!.t <= frameStart) moveIndex += 1
		while (sampleIndex < samples.length && samples[sampleIndex]!.t <= frameStart) sampleIndex += 1
		if (frameEnd < activeStart || frameStart > activeEnd || moves.length === 0) continue
		let eventCount = 0
		while (moveIndex + eventCount < moves.length && moves[moveIndex + eventCount]!.t <= frameEnd) eventCount += 1
		let sampleCountInFrame = 0
		while (sampleIndex + sampleCountInFrame < samples.length && samples[sampleIndex + sampleCountInFrame]!.t <= frameEnd) sampleCountInFrame += 1
		eventsPerFrame[Math.min(2, eventCount)]! += 1
		samplesPerFrame[Math.min(5, sampleCountInFrame)]! += 1
	}

	return {
		events: dom.length,
		byType,
		interval: distribution(intervals),
		gapsOver25ms: intervals.filter((interval) => interval > GAP_MS).map((interval) => round(interval, 1)),
		eventsPerFrame,
		samplesPerFrame,
		coalescedSamples: sampleCount,
		sampleRateHz: activeMs > 0 ? round((sampleCount * 1000) / activeMs, 1) : 0,
		activeMs: round(activeMs, 1),
	}
}

/** LoAF entries and long tasks, with times relative to the recording start. */
export const analyzeLongFrames = (data: RecorderData): LongFramesSection => {
	const origin = data.startedAt ?? 0
	return {
		loaf: data.loaf.map((entry) => ({
			start: round(entry.start - origin, 1),
			duration: round(entry.duration, 1),
			scriptMs: round(entry.scriptMs, 1),
			renderMs: round(entry.renderMs, 1),
			blockingMs: round(entry.blockingMs, 1),
		})),
		longTasks: data.longTasks.map((entry) => ({ start: round(entry.start - origin, 1), duration: round(entry.duration, 1) })),
		supported: data.supported,
	}
}

/**
 * Per-frame steps of an app value (camera, scroll offset) sampled once per rAF.
 *
 * "Frames with input but no motion" is the app-side judder count: input arrived during the frame,
 * yet the value did not move. In the original case steps read `0 0 0 0 0 200 0 0 596`.
 */
export const analyzeProbe = (data: RecorderData, expression: string): ProbeSection => {
	const moves = gestureMoves(data.inputs)
	const steps: number[] = []
	const inputInFrame: boolean[] = []
	let moveIndex = 0
	for (let i = 1; i < data.probe.length; i++) {
		const step = probeStep(data.probe[i - 1]!, data.probe[i]!)
		const frameStart = data.raf[i - 1]!
		const frameEnd = data.raf[i]!
		while (moveIndex < moves.length && moves[moveIndex]!.t <= frameStart) moveIndex += 1
		inputInFrame.push(moveIndex < moves.length && moves[moveIndex]!.t <= frameEnd)
		steps.push(step == null ? 0 : round(step, 3))
	}

	// From the first moving frame to the end of input (not the last motion): a freeze while the
	// drag continues is judder and must stay inside the window.
	const moving = steps.map((step) => step > 1e-6)
	const first = moving.indexOf(true)
	const last = Math.max(moving.lastIndexOf(true), inputInFrame.lastIndexOf(true))
	const inRange = first === -1 ? [] : steps.slice(first, last + 1)
	const typical = median(inRange.filter((step) => step > 1e-6))

	let runs = 0
	let longest = 0
	let current = 0
	for (const step of inRange) {
		if (step > 1e-6) {
			if (current > 0) {
				runs += 1
				longest = Math.max(longest, current)
			}
			current = 0
		} else {
			current += 1
		}
	}
	// A run still open when input ended is a freeze, not a pause between moving frames.
	if (current > 0) {
		runs += 1
		longest = Math.max(longest, current)
	}

	return {
		expression,
		frames: data.probe.length,
		steps,
		framesWithInputNoMotion: steps.filter((step, index) => inputInFrame[index] && step <= 1e-6 && index >= first && index <= last).length,
		zeroRuns: { count: runs, longest },
		doubleSteps: inRange.filter((step) => typical > 0 && step > DOUBLE_STEP_RATIO * typical).length,
		stepCv: round(coefficientOfVariation(inRange), 3),
		totalDisplacement: round(steps.reduce((sum, step) => sum + step, 0), 2),
		errors: data.probeErrors,
	}
}

const probeStep = (previous: number | [number, number] | null, next: number | [number, number] | null): number | null => {
	if (previous == null || next == null) return null
	if (typeof previous === 'number' && typeof next === 'number') return Math.abs(next - previous)
	if (Array.isArray(previous) && Array.isArray(next)) return Math.hypot(next[0] - previous[0], next[1] - previous[1])
	return null
}

/** Raw samples for `--out`, with input times relative to the recording start. */
export const toSamples = (data: RecorderData): PerfSamples => {
	const origin = data.startedAt ?? 0
	return {
		raf: data.raf.map((ts) => round(ts - origin, 3)),
		inputs: data.inputs.map((event): RecordedInputEvent => ({ ...event, t: round(event.t - origin, 3) })),
		...(data.probe.length > 0 ? { probe: data.probe } : {}),
	}
}
