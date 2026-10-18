import type { TraceStartResponse, TraceStopResponse, WatcherRecord } from '@vforsh/argus-core'
import { analyzeMotion } from './analyzeMotion.js'
import { postWatcherJson } from './pageEval.js'
import type { LatencySection, MainFrameSection, MotionSection, PresentationSection } from './runResult.js'
import {
	analyzeLatency,
	analyzeMainFrame,
	analyzePresentation,
	findRecording,
	loadTraceModel,
	pickRendererPid,
	type TraceWindow,
} from './traceAnalysis.js'

/**
 * Category sets behind `argus trace --preset`.
 *
 * `frames` is the set that answered the original investigation (PipelineReporter states and
 * stages, EventLatency, BeginMainFrame), plus `blink.user_timing` so the perf recorder's marks
 * can cut the trace to the measured window.
 */
export const TRACE_PRESETS = {
	frames: 'benchmark,cc,viz,gpu,rail,input,latencyInfo,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',
	input: 'benchmark,cc,input,latencyInfo,rail,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',
	gpu: 'benchmark,cc,viz,gpu,devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-gpu.service,disabled-by-default-viz.gpu_composite_time,blink.user_timing',
} as const

export type TracePreset = keyof typeof TRACE_PRESETS

/** Per-presented-frame screenshots, decoded by `perf motion` / `--motion`. */
export const SCREENSHOT_CATEGORY = 'disabled-by-default-devtools.screenshot'

/** Expand `--preset` and append any explicit `--categories`; `undefined` keeps Chrome's default set. */
export const resolveTraceCategories = (preset: string | undefined, categories?: string, extra: string[] = []): string | undefined => {
	if (preset && !(preset in TRACE_PRESETS)) throw new Error(`unknown --preset ${preset}; expected ${Object.keys(TRACE_PRESETS).join(', ')}`)
	const parts = [preset ? TRACE_PRESETS[preset as TracePreset] : '', categories ?? '', ...extra].flatMap((value) => value.split(','))
	const unique = [...new Set(parts.map((part) => part.trim()).filter(Boolean))]
	return unique.length > 0 ? unique.join(',') : undefined
}

export const startWatcherTrace = (watcher: WatcherRecord, input: { categories?: string; outFile?: string }): Promise<TraceStartResponse> =>
	postWatcherJson<TraceStartResponse>(watcher, '/trace/start', { categories: input.categories, outFile: input.outFile }, 10_000)

export const stopWatcherTrace = (watcher: WatcherRecord, input: { traceId?: string; outFile?: string }): Promise<TraceStopResponse> =>
	postWatcherJson<TraceStopResponse>(watcher, '/trace/stop', { traceId: input.traceId, outFile: input.outFile }, 60_000)

export type TraceAnalysisRequest = {
	frames?: boolean
	input?: boolean
	/** Measure on-screen motion; needs the page viewport to convert screenshot px to CSS px. */
	motion?: {
		viewport: { width: number; height: number }
		clip?: { x: number; y: number; width: number; height: number }
		/** When input was active, in page `performance.now()` ms (converted through the start mark). */
		inputActivePageMs?: { start: number; end: number }
	}
	pid?: number
	/** The recorder whose marks define the window, pid and clock; default: the last recording in the trace. */
	recordingToken?: string
}

export type TraceAnalysis = {
	pid: number | null
	window: TraceWindow | null
	events: number
	presentation?: PresentationSection
	latency?: LatencySection
	mainFrame?: MainFrameSection
	motion?: MotionSection | null
}

/** Stream a trace file once and run the requested analyzers over the page's renderer. */
export const analyzeTraceFile = async (filePath: string, request: TraceAnalysisRequest): Promise<TraceAnalysis> => {
	const model = await loadTraceModel(filePath, { screenshots: request.motion != null, recordingToken: request.recordingToken })
	const recording = findRecording(model, request.recordingToken)
	const pid = pickRendererPid(model, request.pid, recording)
	const window = recording?.window ?? null
	const analysis: TraceAnalysis = { pid, window, events: model.events }
	if (pid != null) {
		if (request.frames) {
			analysis.presentation = analyzePresentation(model, pid, window)
			analysis.mainFrame = analyzeMainFrame(model, pid, window)
		}
		if (request.input) analysis.latency = analyzeLatency(model, pid, window)
	}
	if (request.motion) {
		const toTrace = recording?.toTraceUs
		const active = request.motion.inputActivePageMs
		analysis.motion = analyzeMotion(model.screenshots, {
			viewport: request.motion.viewport,
			clip: request.motion.clip,
			window,
			inputActive: active && toTrace ? { start: toTrace(active.start), end: toTrace(active.end) } : null,
		})
	}
	return analysis
}
