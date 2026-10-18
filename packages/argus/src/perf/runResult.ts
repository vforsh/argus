import type { Distribution } from './stats.js'

/**
 * The one result shape that `perf gesture`, `perf capture`, `perf motion` and `trace analyze` write.
 *
 * Every producer fills the sections it measured and leaves the rest absent, so `perf compare` can
 * diff any pair of results: it reads only `summary`, a flat map of headline metrics that every
 * section contributes to. Bump {@link PERF_RUN_VERSION} on a breaking change to a section shape.
 */
export type PerfRunResult = {
	schema: typeof PERF_RUN_SCHEMA
	version: typeof PERF_RUN_VERSION
	kind: 'gesture' | 'capture' | 'motion' | 'trace'
	meta: PerfRunMeta
	validity: PerfValidity
	/** Headline metrics by dotted name (`presentation.partialShare`); repeats report the median with spread. */
	summary: Record<string, PerfMetric>
	input?: InputSection
	raf?: RafSection
	longFrames?: LongFramesSection
	probe?: ProbeSection
	presentation?: PresentationSection
	latency?: LatencySection
	mainFrame?: MainFrameSection
	motion?: MotionSection
	/** Delivery statistics from the watcher's input player (`perf gesture`, `input replay`). */
	playback?: PlaybackSection
	/** Per-repeat sections when `--repeat` > 1; the top-level sections then describe the median run. */
	runs?: PerfRunRepeat[]
	/** Raw page samples (`perf capture --out`): rAF stamps, input events, probe values. */
	samples?: PerfSamples
}

export const PERF_RUN_SCHEMA = 'argus.perf.run'
export const PERF_RUN_VERSION = 1

/** One headline metric. `better` says which direction is an improvement, for `perf compare`. */
export type PerfMetric = {
	value: number
	unit: 'ms' | 'px' | 'ratio' | 'count' | 'fps' | 'hz'
	better: 'lower' | 'higher'
	/** Present when the value aggregates repeats: the spread across them is the noise floor. */
	min?: number
	max?: number
	repeats?: number
}

export type PerfRunMeta = {
	createdAt: string
	argusVersion: string
	watcherId?: string
	url?: string
	userAgent?: string
	headless?: boolean
	glRenderer?: string
	viewport?: { width: number; height: number; devicePixelRatio: number }
	traceFile?: string
	tracePid?: number
	/** Gesture/capture window in the trace clock (µs), from the recorder's `argus-perf-*` marks. */
	traceWindowUs?: { start: number; end: number }
	command?: string
	options?: Record<string, unknown>
	host?: { platform: string; cpus: number; loadAvg1m: number; chromeInstances?: number }
}

/**
 * Whether the run measured what it claims. A run with `valid: false` is still written so the reason
 * is visible, but `perf compare` refuses to call it better or worse.
 */
export type PerfValidity = {
	valid: boolean
	reasons: PerfValidityIssue[]
	warnings: PerfValidityIssue[]
}

export type PerfValidityIssue = {
	code: 'headless' | 'page_hidden' | 'raf_throttled' | 'software_gl' | 'trace_data_loss' | 'no_motion' | 'high_load' | 'other_chrome' | 'no_input' | 'no_renderer' | 'motion_unmeasurable' | 'too_short'
	message: string
	/** Sections whose numbers this issue distorts; their summary metrics are dropped. */
	sections?: string[]
}

export type InputSection = {
	events: number
	/** Events per type (pointermove, pointerdown, wheel, …). */
	byType: Record<string, number>
	/** Interval between consecutive move/wheel events, ms. */
	interval: Distribution
	/** Gaps over 25 ms between consecutive move/wheel events while input was active. */
	gapsOver25ms: number[]
	/** DOM move/wheel events delivered per rAF frame while input was active: index 0, 1, 2+. */
	eventsPerFrame: [number, number, number]
	/** Raw (coalesced) samples per frame while input was active: index 0…4, 5+. */
	samplesPerFrame: number[]
	/** Total `getCoalescedEvents()` samples and the rate they imply. */
	coalescedSamples: number
	sampleRateHz: number
	activeMs: number
}

export type RafSection = {
	frames: number
	fps: number
	interval: Distribution
	/** Intervals over 20 ms: [offset from start ms, interval ms]. */
	over20ms: [number, number][]
}

export type LongFramesSection = {
	loaf: { start: number; duration: number; scriptMs: number; renderMs: number; blockingMs: number }[]
	longTasks: { start: number; duration: number }[]
	supported: { loaf: boolean; longTask: boolean }
}

export type ProbeSection = {
	expression: string
	frames: number
	steps: number[]
	framesWithInputNoMotion: number
	zeroRuns: { count: number; longest: number }
	doubleSteps: number
	stepCv: number
	totalDisplacement: number
	errors: number
}

export type PresentationSection = {
	pid: number
	states: Record<string, number>
	frameTypes: Record<string, number>
	/** PRESENTED_PARTIAL / (PRESENTED_ALL + PRESENTED_PARTIAL). */
	partialShare: number
	/** DROPPED / (PRESENTED_ALL + PRESENTED_PARTIAL + DROPPED). */
	droppedShare: number
	/** Average stage duration (ms) per presentation state. */
	stagesByState: Record<string, Record<string, number>>
	/** Interval between consecutive presented frames, ms. */
	presentedInterval: Distribution & { over20ms: number }
}

export type LatencyTypeStats = {
	count: number
	total: Distribution
	/** Share of events whose latency reaches a presentation stage. */
	attributedShare: number
	/** Average stage duration (ms), direct children only. */
	stages: Record<string, number>
}

export type LatencySection = {
	pid: number
	byType: Record<string, LatencyTypeStats>
	mouse: { count: number; p50: number; p95: number; attributedShare: number; presentationAttributed: boolean }
	/** Human-readable flags, e.g. presentation not attributed for rAF/WebGL-driven apps. */
	flags: string[]
}

export type MainFrameSection = {
	pid: number
	tid: number | null
	beginMainFrame: Distribution
	/** Average ms per main frame from `SendBeginMainFrameToCommit` breakdowns. */
	breakdown: Record<string, number>
}

export type MotionSection = {
	frames: number
	presentedFps: number
	/** Per-frame displacement (CSS px) between consecutive presented frames; null where it could not be measured. */
	steps: (number | null)[]
	/** Signed per-frame displacement [dx, dy] in CSS px; null where it could not be measured. */
	vectors: ([number, number] | null)[]
	zeroStepFrames: number
	doubleSteps: number
	stepCv: number
	medianStep: number
	longestStallMs: number
	totalDisplacement: number
	/** Frames whose correlation peak was too weak to trust (flat or changing content); excluded from every metric. */
	lowConfidenceFrames: number
	sparkline: string
	screenshotSize?: { width: number; height: number }
	clip?: { x: number; y: number; width: number; height: number }
}

export type PlaybackSection = {
	requested: number
	dispatched: number
	durationMs: number
	rateHz: number
	latenessMs: { p50: number; p95: number; max: number }
	ackMs: { p50: number; p95: number; max: number }
	inFlightStalls: number
	error?: string
}

export type PerfRunRepeat = Omit<PerfRunResult, 'schema' | 'version' | 'kind' | 'meta' | 'runs' | 'samples'> & { index: number }

export type PerfSamples = {
	raf: number[]
	inputs: RecordedInputEvent[]
	probe?: (number | [number, number] | null)[]
}

/** One input event as the page recorder saw it (also the `argus input record` line format). */
export type RecordedInputEvent = {
	/** ms since the recorder's start (performance timeline). */
	t: number
	type: string
	x?: number
	y?: number
	button?: number
	buttons?: number
	deltaX?: number
	deltaY?: number
	deltaMode?: number
	key?: string
	code?: string
	/** Bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 (CDP order). */
	modifiers?: number
	pointerType?: string
	pointerId?: number
	/** For pointermove: how many raw samples this DOM event coalesced. */
	coalesced?: number
	/** True for a raw sample unpacked from `getCoalescedEvents()` rather than a dispatched DOM event. */
	raw?: boolean
}

/** Start a result with empty validity and summary. */
export const createRunResult = (kind: PerfRunResult['kind'], meta: PerfRunMeta): PerfRunResult => ({
	schema: PERF_RUN_SCHEMA,
	version: PERF_RUN_VERSION,
	kind,
	meta,
	validity: { valid: true, reasons: [], warnings: [] },
	summary: {},
})

/** True when a parsed JSON value is a run result this CLI understands. */
export const isPerfRunResult = (value: unknown): value is PerfRunResult =>
	typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === PERF_RUN_SCHEMA

/**
 * Rebuild `summary` from the sections present, leaving out sections a validity issue distorts.
 *
 * Kept as one table so every producer (gesture, capture, motion, trace analyze) names the same
 * metric the same way, which is what lets `perf compare` line up any two results.
 */
export const summarizeSections = (result: Omit<PerfRunRepeat, 'summary' | 'index'>): Record<string, PerfMetric> => {
	const distorted = new Set([...result.validity.reasons, ...result.validity.warnings].flatMap((issue) => issue.sections ?? []))
	const summary: Record<string, PerfMetric> = {}
	const put = (section: string, name: string, value: number | undefined, unit: PerfMetric['unit'], better: PerfMetric['better']): void => {
		if (value == null || !Number.isFinite(value) || distorted.has(section)) return
		summary[`${section}.${name}`] = { value, unit, better }
	}

	const { presentation, latency, mainFrame, motion, raf, input, probe, longFrames, playback } = result
	if (presentation) {
		put('presentation', 'partialShare', presentation.partialShare, 'ratio', 'lower')
		put('presentation', 'droppedShare', presentation.droppedShare, 'ratio', 'lower')
		put('presentation', 'forked', presentation.frameTypes['FORKED'] ?? 0, 'count', 'lower')
		put('presentation', 'presentedOver20ms', presentation.presentedInterval.over20ms, 'count', 'lower')
		put('presentation', 'longestPresentedIntervalMs', presentation.presentedInterval.max, 'ms', 'lower')
	}
	if (latency && latency.mouse.count > 0) {
		// Unattributed latency stops at main-thread handling; a distinct name keeps `perf compare` from
		// calling a rAF-driven app "faster" than one that updates the DOM in its handler.
		const prefix = latency.mouse.presentationAttributed ? 'mouse' : 'mouseUnattributed'
		put('latency', `${prefix}P50Ms`, latency.mouse.p50, 'ms', 'lower')
		put('latency', `${prefix}P95Ms`, latency.mouse.p95, 'ms', 'lower')
	}
	if (mainFrame) {
		put('mainFrame', 'beginMainFrameP50Ms', mainFrame.beginMainFrame.p50, 'ms', 'lower')
		put('mainFrame', 'beginMainFrameP90Ms', mainFrame.beginMainFrame.p90, 'ms', 'lower')
	}
	if (motion) {
		put('motion', 'zeroStepFrames', motion.zeroStepFrames, 'count', 'lower')
		put('motion', 'doubleSteps', motion.doubleSteps, 'count', 'lower')
		put('motion', 'stepCv', motion.stepCv, 'ratio', 'lower')
		put('motion', 'longestStallMs', motion.longestStallMs, 'ms', 'lower')
		put('motion', 'presentedFps', motion.presentedFps, 'fps', 'higher')
	}
	if (raf) {
		put('raf', 'fps', raf.fps, 'fps', 'higher')
		put('raf', 'over20ms', raf.over20ms.length, 'count', 'lower')
		put('raf', 'longestFrameMs', raf.interval.max, 'ms', 'lower')
	}
	if (input) {
		put('input', 'sampleRateHz', input.sampleRateHz, 'hz', 'higher')
		put('input', 'framesWithoutInput', input.eventsPerFrame[0], 'count', 'lower')
		put('input', 'gapsOver25ms', input.gapsOver25ms.length, 'count', 'lower')
	}
	if (probe) {
		put('probe', 'framesWithInputNoMotion', probe.framesWithInputNoMotion, 'count', 'lower')
		put('probe', 'doubleSteps', probe.doubleSteps, 'count', 'lower')
		put('probe', 'stepCv', probe.stepCv, 'ratio', 'lower')
	}
	if (longFrames) {
		put('longFrames', 'loafCount', longFrames.loaf.length, 'count', 'lower')
	}
	if (playback) {
		put('playback', 'rateHz', playback.rateHz, 'hz', 'higher')
	}
	return summary
}
