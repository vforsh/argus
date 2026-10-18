import type { LatencySection, LatencyTypeStats, MainFrameSection, PresentationSection } from './runResult.js'
import { distribution, round } from './stats.js'
import { streamTraceEvents, type TraceEvent } from './traceStream.js'

/** Stages of a `PipelineReporter` frame, in pipeline order. */
export const PIPELINE_STAGES = [
	'BeginImplFrameToSendBeginMainFrame',
	'SendBeginMainFrameToCommit',
	'Commit',
	'EndCommitToActivation',
	'Activation',
	'EndActivateToSubmitCompositorFrame',
	'SubmitCompositorFrameToPresentationCompositorFrame',
] as const

const PRESENTATION_STAGE = 'SubmitCompositorFrameToPresentationCompositorFrame'
/** Older Chrome builds report the frame state as an enum number instead of its name. */
const FRAME_STATE_NAMES = ['STATE_NO_UPDATE_DESIRED', 'STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL', 'STATE_DROPPED']
const MAIN_FRAME_BREAKDOWN_ARG = 'send_begin_mainframe_to_commit_breakdown'
/** Marks the page recorder drops so a trace can be cut to the measured window (see `pageRecorder.ts`). */
export const ARGUS_MARK_START = 'argus-perf-start'
export const ARGUS_MARK_END = 'argus-perf-end'
/** Screenshots kept around the recording window: enough for the reference frame before it. */
const SCREENSHOT_MARGIN_US = 200_000

type AsyncSpan = { name: string; start: number; end: number; args?: Record<string, any> }
type OpenSpan = { start: number; args?: Record<string, any> }

/** A decoded-later screenshot reference; `ts` is the expected display time (µs, trace clock). */
export type TraceScreenshot = { ts: number; frameSequence?: number; snapshot: string }

/** Everything one streaming pass keeps from a trace: small per-frame records, never the raw events. */
export type TraceModel = {
	events: number
	bytes: number
	processNames: Map<number, string>
	threadNames: Map<string, string>
	beginMainFrameByPid: Map<number, number>
	/** `PipelineReporter` and `EventLatency` roots keyed by `pid`. */
	pipelineReporters: Map<number, AsyncSpan[]>
	eventLatencies: Map<number, AsyncSpan[]>
	/** Child stages keyed by `pid|tid|id`, sorted by start once the pass ends. */
	stages: Map<string, AsyncSpan[]>
	/** Root spans remember their stage key so children can be found by time containment. */
	stageKeys: WeakMap<AsyncSpan, string>
	beginMainFrames: { pid: number; tid: number; ts: number; dur: number }[]
	mainFrameBreakdowns: { pid: number; ts: number; breakdown: Record<string, number> }[]
	marks: { name: string; pid: number; ts: number; startTime?: number }[]
	/** Per-frame screenshots, when requested; pruned to the recording window while streaming. */
	screenshots: TraceScreenshot[]
}

/**
 * Read a trace once and keep the pieces the frames/input/motion analyzers need.
 *
 * Async spans are paired with a stack per (pid, tid, id, name): Chrome reuses `id2.local` values,
 * so pairing `b`/`e` by id alone drops or cross-wires most spans. Children are matched to their
 * root later by time containment within the same (pid, tid, id) track.
 */
export const loadTraceModel = async (filePath: string, options: { screenshots?: boolean; recordingToken?: string } = {}): Promise<TraceModel> => {
	const model: TraceModel = {
		events: 0,
		bytes: 0,
		processNames: new Map(),
		threadNames: new Map(),
		beginMainFrameByPid: new Map(),
		pipelineReporters: new Map(),
		eventLatencies: new Map(),
		stages: new Map(),
		stageKeys: new WeakMap(),
		beginMainFrames: [],
		mainFrameBreakdowns: [],
		marks: [],
		screenshots: [],
	}
	const open = new Map<string, OpenSpan[]>()
	// Screenshots are the only large payload. Once the recording's marks have streamed past, frames
	// outside its window (plus a reference frame's margin) are dropped instead of held to the end.
	const startMark = `${ARGUS_MARK_START}:${options.recordingToken ?? ''}`
	const endMark = `${ARGUS_MARK_END}:${options.recordingToken ?? ''}`
	let keepFrom = -Infinity
	let keepUntil = Infinity

	const onAsync = (event: TraceEvent): void => {
		const id = event.id2?.local ?? event.id2?.global ?? (event.id == null ? undefined : String(event.id))
		if (id == null || event.pid == null || event.ts == null || !event.name) return
		const track = `${event.pid}|${event.tid ?? 0}|${id}`
		const key = `${track}|${event.name}`
		if (event.ph === 'b') {
			const stack = open.get(key) ?? []
			stack.push({ start: event.ts, args: hasArgs(event.args) ? event.args : undefined })
			open.set(key, stack)
			return
		}
		const stack = open.get(key)
		const begin = stack?.pop()
		if (!begin) return
		const args = hasArgs(event.args) ? { ...begin.args, ...event.args } : begin.args
		const span: AsyncSpan = { name: event.name, start: begin.start, end: event.ts, args }
		if (event.name === 'PipelineReporter' || event.name === 'EventLatency') {
			const roots = event.name === 'PipelineReporter' ? model.pipelineReporters : model.eventLatencies
			const list = roots.get(event.pid) ?? []
			list.push(span)
			roots.set(event.pid, list)
			model.stageKeys.set(span, track)
			return
		}
		const list = model.stages.get(track) ?? []
		list.push({ name: span.name, start: span.start, end: span.end })
		model.stages.set(track, list)
		if (event.name === 'SendBeginMainFrameToCommit' && args?.[MAIN_FRAME_BREAKDOWN_ARG]) {
			model.mainFrameBreakdowns.push({ pid: event.pid, ts: begin.start, breakdown: args[MAIN_FRAME_BREAKDOWN_ARG] })
		}
	}

	const stats = await streamTraceEvents(filePath, (event) => {
		switch (event.ph) {
			case 'b':
			case 'e':
				onAsync(event)
				return
			case 'X':
				if (event.name === 'ProxyMain::BeginMainFrame' && event.pid != null && event.ts != null) {
					model.beginMainFrameByPid.set(event.pid, (model.beginMainFrameByPid.get(event.pid) ?? 0) + 1)
					model.beginMainFrames.push({ pid: event.pid, tid: event.tid ?? 0, ts: event.ts, dur: event.dur ?? 0 })
				}
				return
			case 'M':
				if (event.name === 'process_name' && event.pid != null) model.processNames.set(event.pid, String(event.args?.name ?? ''))
				if (event.name === 'thread_name' && event.pid != null) model.threadNames.set(`${event.pid}|${event.tid}`, String(event.args?.name ?? ''))
				return
		}
		if (event.name === 'Screenshot' && typeof event.args?.snapshot === 'string') {
			if (!options.screenshots) return
			const ts = typeof event.args.expected_display_time === 'number' ? event.args.expected_display_time : (event.ts ?? 0)
			if (ts >= keepFrom && ts <= keepUntil) model.screenshots.push({ ts, frameSequence: event.args.frame_sequence, snapshot: event.args.snapshot })
			return
		}
		if (event.name?.startsWith('argus-perf-') && event.pid != null && event.ts != null) {
			model.marks.push({ name: event.name, pid: event.pid, ts: event.ts, startTime: event.args?.data?.startTime })
			if (options.recordingToken == null) return
			if (event.name === startMark) {
				keepFrom = event.ts - SCREENSHOT_MARGIN_US
				model.screenshots = model.screenshots.filter((shot) => shot.ts >= keepFrom)
			} else if (event.name === endMark) {
				keepUntil = event.ts + SCREENSHOT_MARGIN_US
				model.screenshots = model.screenshots.filter((shot) => shot.ts <= keepUntil)
			}
		}
	})

	model.events = stats.events
	model.bytes = stats.bytes
	for (const list of model.stages.values()) list.sort((a, b) => a.start - b.start)
	return model
}

const hasArgs = (args: Record<string, any> | undefined): args is Record<string, any> => args != null && Object.keys(args).length > 0

/** A time window in the trace clock (µs). */
export type TraceWindow = { start: number; end: number }

/** One recorder's marks in a trace: its renderer, its window and its page→trace clock mapping. */
export type MarkedRecording = {
	pid: number
	/** Null when the end mark is missing (the run was cut short). */
	window: TraceWindow | null
	/** Page `performance.now()` ms → trace µs, from the start mark, which carries both clocks. */
	toTraceUs: ((pageMs: number) => number) | null
}

/**
 * Find a recorder's marks: the one with `token`, else the last recording in the trace. Pid, window
 * and clock mapping all come from that one recording, so concurrent recorders never mix.
 */
export const findRecording = (model: TraceModel, token?: string): MarkedRecording | null => {
	const starts = model.marks.filter((mark) => mark.name.startsWith(`${ARGUS_MARK_START}:`))
	const start = token == null ? starts.at(-1) : starts.find((mark) => mark.name === `${ARGUS_MARK_START}:${token}`)
	if (!start) return null
	const suffix = start.name.slice(ARGUS_MARK_START.length)
	const end = model.marks.find((mark) => mark.name === `${ARGUS_MARK_END}${suffix}` && mark.ts > start.ts)
	const startTime = start.startTime
	return {
		pid: start.pid,
		window: end ? { start: start.ts, end: end.ts } : null,
		toTraceUs: startTime == null ? null : (pageMs) => pageMs * 1000 + (start.ts - startTime * 1000),
	}
}

/** Explicit `--pid`, else the recording's renderer, else the renderer with the most `BeginMainFrame` events. */
export const pickRendererPid = (model: TraceModel, explicitPid?: number, recording?: MarkedRecording | null): number | null => {
	if (explicitPid != null) return explicitPid
	if (recording) return recording.pid
	let best: number | null = null
	let bestCount = 0
	for (const [pid, count] of model.beginMainFrameByPid) {
		if (count > bestCount) {
			best = pid
			bestCount = count
		}
	}
	return best
}

const inWindow = (ts: number, window: TraceWindow | null): boolean => !window || (ts >= window.start && ts <= window.end)

/** Children of a root span on its track, matched by time containment (ids are reused, so the id alone proves nothing). */
const childrenOf = (model: TraceModel, root: AsyncSpan): AsyncSpan[] => {
	const track = model.stageKeys.get(root)
	const list = track ? model.stages.get(track) : undefined
	if (!list) return []
	let lo = 0
	let hi = list.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (list[mid]!.start < root.start) lo = mid + 1
		else hi = mid
	}
	const children: AsyncSpan[] = []
	for (let i = lo; i < list.length && list[i]!.start <= root.end; i++) {
		if (list[i]!.end <= root.end) children.push(list[i]!)
	}
	return children
}

/** Keep only children not nested inside a sibling (EventLatency stages have sub-stages). */
const directChildren = (children: AsyncSpan[]): AsyncSpan[] => {
	const sorted = [...children].sort((a, b) => a.start - b.start || b.end - a.end)
	const direct: AsyncSpan[] = []
	let coverEnd = -Infinity
	for (const child of sorted) {
		if (child.start >= coverEnd || child.end > coverEnd) {
			direct.push(child)
			coverEnd = child.end
		}
	}
	return direct
}

const frameState = (span: AsyncSpan): string => {
	const reporter = span.args?.['frame_reporter'] ?? span.args?.['chrome_frame_reporter'] ?? {}
	const state = reporter.state
	if (typeof state === 'number') return FRAME_STATE_NAMES[state] ?? `STATE_${state}`
	return typeof state === 'string' ? state : 'STATE_UNKNOWN'
}

const frameType = (span: AsyncSpan): string | null => {
	const reporter = span.args?.['frame_reporter'] ?? span.args?.['chrome_frame_reporter'] ?? {}
	return typeof reporter.frame_type === 'string' ? reporter.frame_type : null
}

/** Frame presentation per renderer: state counts, FORKED/BACKFILL, partial share and per-state stage breakdown. */
export const analyzePresentation = (model: TraceModel, pid: number, window: TraceWindow | null): PresentationSection => {
	const spans = (model.pipelineReporters.get(pid) ?? []).filter((span) => inWindow(span.start, window))
	const states: Record<string, number> = {}
	const frameTypes: Record<string, number> = {}
	const stageTotals: Record<string, Record<string, { sum: number; count: number }>> = {}
	const presentedEnds: number[] = []

	for (const span of spans) {
		const state = frameState(span)
		states[state] = (states[state] ?? 0) + 1
		const type = frameType(span)
		if (type) frameTypes[type] = (frameTypes[type] ?? 0) + 1
		if (state === 'STATE_PRESENTED_ALL' || state === 'STATE_PRESENTED_PARTIAL') {
			presentedEnds.push(span.end)
			const totals = (stageTotals[state] ??= {})
			for (const child of childrenOf(model, span)) {
				if (!(PIPELINE_STAGES as readonly string[]).includes(child.name)) continue
				const entry = (totals[child.name] ??= { sum: 0, count: 0 })
				entry.sum += child.end - child.start
				entry.count += 1
			}
		}
	}

	const all = states['STATE_PRESENTED_ALL'] ?? 0
	const partial = states['STATE_PRESENTED_PARTIAL'] ?? 0
	const dropped = states['STATE_DROPPED'] ?? 0
	const stagesByState: PresentationSection['stagesByState'] = {}
	for (const [state, totals] of Object.entries(stageTotals)) {
		stagesByState[state] = {}
		for (const stage of PIPELINE_STAGES) {
			const entry = totals[stage]
			if (entry) stagesByState[state]![stage] = round(entry.sum / entry.count / 1000, 3)
		}
	}

	// Several reporters can present on one vsync (FORKED + main frame); collapse to unique presentation times.
	const uniqueEnds = [...new Set(presentedEnds.map((end) => Math.round(end / 1000)))].sort((a, b) => a - b)
	const intervals = uniqueEnds.slice(1).map((end, index) => end - uniqueEnds[index]!)
	return {
		pid,
		states,
		frameTypes,
		partialShare: all + partial === 0 ? 0 : round(partial / (all + partial), 4),
		droppedShare: all + partial + dropped === 0 ? 0 : round(dropped / (all + partial + dropped), 4),
		stagesByState,
		presentedInterval: { ...distribution(intervals), over20ms: intervals.filter((interval) => interval > 20).length },
	}
}

/** `EventLatency` per event type with direct stages, and whether presentation was attributed at all. */
export const analyzeLatency = (model: TraceModel, pid: number, window: TraceWindow | null): LatencySection => {
	const own = model.eventLatencies.get(pid) ?? []
	// Some builds report EventLatency from another process than the one that ran the frames.
	const spans = (own.length > 0 ? own : [...model.eventLatencies.values()].flat()).filter((span) => inWindow(span.start, window))
	type LatencyGroup = { totals: number[]; attributed: number; stages: Map<string, { sum: number; count: number }> }
	const groups = new Map<string, LatencyGroup>()

	for (const span of spans) {
		const type = String(span.args?.['event_latency']?.event_type ?? span.args?.['data']?.event_type ?? 'UNKNOWN')
		const group: LatencyGroup = groups.get(type) ?? { totals: [], attributed: 0, stages: new Map() }
		groups.set(type, group)
		group.totals.push((span.end - span.start) / 1000)
		const children = childrenOf(model, span)
		if (children.some((child) => child.name === PRESENTATION_STAGE)) group.attributed += 1
		for (const child of directChildren(children)) {
			const entry = group.stages.get(child.name) ?? { sum: 0, count: 0 }
			entry.sum += child.end - child.start
			entry.count += 1
			group.stages.set(child.name, entry)
		}
	}

	const byType: Record<string, LatencyTypeStats> = {}
	const mouseTotals: number[] = []
	let mouseAttributed = 0
	for (const [type, group] of [...groups].sort((a, b) => b[1].totals.length - a[1].totals.length)) {
		const stages: Record<string, number> = {}
		for (const [name, entry] of group.stages) stages[name] = round(entry.sum / entry.count / 1000, 3)
		byType[type] = {
			count: group.totals.length,
			total: distribution(group.totals),
			attributedShare: round(group.attributed / group.totals.length, 3),
			stages,
		}
		if (type.startsWith('MOUSE_')) {
			mouseTotals.push(...group.totals)
			mouseAttributed += group.attributed
		}
	}

	const mouseShare = mouseTotals.length === 0 ? 0 : mouseAttributed / mouseTotals.length
	const flags: string[] = []
	const mouseDist = distribution(mouseTotals)
	if (mouseTotals.length > 0 && mouseShare < 0.5) {
		flags.push(
			`presentation not attributed: only ${Math.round(mouseShare * 100)}% of mouse EventLatency reach a presentation stage. ` +
				'The page likely renders from rAF/WebGL rather than in the event handler, so these latencies stop at main-thread ' +
				'handling and are NOT comparable with an app that updates the DOM in its handler.',
		)
	}
	return {
		pid,
		byType,
		mouse: { count: mouseTotals.length, p50: mouseDist.p50, p95: mouseDist.p95, attributedShare: round(mouseShare, 3), presentationAttributed: mouseShare >= 0.5 },
		flags,
	}
}

/** `ProxyMain::BeginMainFrame` cost on the renderer main thread and what is inside it. */
export const analyzeMainFrame = (model: TraceModel, pid: number, window: TraceWindow | null): MainFrameSection => {
	const mainTid = [...model.threadNames].find(([key, name]) => key.startsWith(`${pid}|`) && name === 'CrRendererMain')?.[0].split('|')[1]
	const tid = mainTid == null ? null : Number(mainTid)
	const frames = model.beginMainFrames.filter((frame) => frame.pid === pid && (tid == null || frame.tid === tid) && inWindow(frame.ts, window))

	const sums: Record<string, number> = {}
	const breakdowns = model.mainFrameBreakdowns.filter((entry) => entry.pid === pid && inWindow(entry.ts, window))
	for (const { breakdown } of breakdowns) {
		for (const [key, value] of Object.entries(breakdown)) {
			if (typeof value !== 'number') continue
			const name = key.replace(/_us$/, '')
			sums[name] = (sums[name] ?? 0) + value
		}
	}
	const breakdown: Record<string, number> = {}
	for (const [name, sum] of Object.entries(sums).sort((a, b) => b[1] - a[1])) {
		breakdown[name] = round(sum / Math.max(1, breakdowns.length) / 1000, 3)
	}

	return { pid, tid, beginMainFrame: distribution(frames.map((frame) => frame.dur / 1000)), breakdown }
}
