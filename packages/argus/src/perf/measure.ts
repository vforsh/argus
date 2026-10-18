import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TraceStopResponse, WatcherRecord } from '@vforsh/argus-core'
import packageJson from '../../package.json' with { type: 'json' }
import { analyzeInput, analyzeLongFrames, analyzeProbe, analyzeRaf, gestureMoves, toSamples } from './analyzeSamples.js'
import { installPageRecorder, type PageRecorder, type RecorderConfig, type RecorderData } from './pageRecorder.js'
import {
	createRunResult,
	summarizeSections,
	type PerfMetric,
	type PerfRunMeta,
	type PerfRunRepeat,
	type PerfRunResult,
	type PerfValidity,
	type PlaybackSection,
} from './runResult.js'
import { median } from './stats.js'
import { analyzeTraceFile, startWatcherTrace, stopWatcherTrace, type TraceAnalysis } from './traceRun.js'
import { evaluateValidity, type PageEnvironment } from './validity.js'
import { createTeardown } from './teardown.js'

export type MeasureRequest = {
	watcher: WatcherRecord
	env: PageEnvironment
	host: PerfRunMeta['host']
	recorder: RecorderConfig
	/** Trace categories, or null to skip tracing. */
	traceCategories: string | null
	/** Measure on-screen motion from trace screenshots (needs `traceCategories` with the screenshot category). */
	motion: { clip?: { x: number; y: number; width: number; height: number } } | null
	/** Keep the raw trace at this path; otherwise it goes to a temp file that is deleted after analysis. */
	keepTraceAt?: string
	allowHeadless?: boolean
	expectInput: boolean
	/** Drives the measured window: plays a gesture, or waits for a human. Returns playback stats when it played input. */
	drive: (recorder: PageRecorder) => Promise<PlaybackSection | undefined>
	pid?: number
}

export type MeasuredRun = {
	repeat: Omit<PerfRunRepeat, 'index'>
	data: RecorderData
	traceFile?: string
	tracePid?: number | null
	traceWindowUs?: { start: number; end: number } | null
}

/**
 * One measured window: trace on → recorder in → drive → recorder out → trace off → analyze.
 *
 * Teardown is unconditional: the recorder is uninstalled and the trace stopped even when driving
 * fails, the session deadline expired or the user pressed Ctrl+C (see `createTeardown`), so an
 * aborted run never leaves listeners in the page or Chrome's single trace slot taken.
 */
export const measureOnce = async (request: MeasureRequest): Promise<MeasuredRun> => {
	const teardown = createTeardown()
	let data: RecorderData
	let playback: PlaybackSection | undefined
	let traceStop: TraceStopResponse | null = null
	let recordingToken: string | undefined
	try {
		let stopTrace: (() => Promise<TraceStopResponse>) | null = null
		if (request.traceCategories) {
			const outFile = request.keepTraceAt ?? path.join(os.tmpdir(), `argus-perf-${process.pid}-${Date.now()}.json`)
			const { traceId } = await startWatcherTrace(request.watcher, { categories: request.traceCategories, outFile })
			stopTrace = () => stopWatcherTrace(request.watcher, { traceId })
			// Aborted runs: stop the trace and drop the temp file nobody will analyze.
			teardown.add(async () => {
				const stopped = await stopTrace!()
				if (!request.keepTraceAt) await fs.rm(stopped.outFile, { force: true })
			})
		}
		const recorder = await installPageRecorder(request.watcher, request.recorder)
		recordingToken = recorder.token
		teardown.add(recorder.uninstall)
		playback = await request.drive(recorder)
		data = await recorder.collect()

		teardown.remove(recorder.uninstall)
		await recorder.uninstall().catch(() => undefined)
		if (stopTrace) {
			teardown.clear()
			traceStop = await stopTrace()
		}
	} finally {
		await teardown.dispose()
	}

	const moves = gestureMoves(data.inputs)
	const repeat: Omit<PerfRunRepeat, 'index'> = {
		validity: { valid: true, reasons: [], warnings: [] },
		summary: {},
		raf: analyzeRaf(data),
		input: analyzeInput(data),
		longFrames: analyzeLongFrames(data),
		...(request.recorder.probe ? { probe: analyzeProbe(data, request.recorder.probe) } : {}),
		...(playback ? { playback } : {}),
	}

	let analysis: TraceAnalysis | null = null
	if (traceStop) {
		try {
			analysis = await analyzeTraceFile(traceStop.outFile, {
				frames: true,
				input: true,
				pid: request.pid,
				recordingToken,
				motion: request.motion
					? {
							viewport: data.viewport,
							clip: request.motion.clip,
							inputActivePageMs: moves.length > 0 ? { start: moves[0]!.t, end: moves.at(-1)!.t } : undefined,
						}
					: undefined,
			})
		} finally {
			if (!request.keepTraceAt) await fs.rm(traceStop.outFile, { force: true })
		}
		if (analysis.presentation) repeat.presentation = analysis.presentation
		if (analysis.latency) repeat.latency = analysis.latency
		if (analysis.mainFrame) repeat.mainFrame = analysis.mainFrame
		if (analysis.motion) repeat.motion = analysis.motion
	}

	repeat.validity = evaluateValidity({
		env: request.env,
		host: request.host,
		allowHeadless: request.allowHeadless,
		recorder: data,
		raf: repeat.raf,
		probe: repeat.probe,
		expectInput: request.expectInput,
		...(analysis ? { motion: analysis.motion, motionRequested: request.motion != null, traceDataLoss: traceStop?.dataLossOccurred } : {}),
	})
	repeat.summary = summarizeSections(repeat)

	return { repeat, data, traceFile: request.keepTraceAt ? traceStop?.outFile : undefined, tracePid: analysis?.pid, traceWindowUs: analysis?.window }
}

/** Base `meta` for a run result. */
export const buildMeta = (watcher: WatcherRecord, env: PageEnvironment, host: PerfRunMeta['host'], extra: Partial<PerfRunMeta>): PerfRunMeta => ({
	createdAt: new Date().toISOString(),
	argusVersion: packageJson.version,
	watcherId: watcher.id,
	url: env.url,
	userAgent: env.userAgent,
	headless: env.headless,
	...(env.glRenderer ? { glRenderer: env.glRenderer } : {}),
	viewport: env.viewport,
	host,
	...extra,
})

/** Priority order for choosing the representative (median) run of a repeat set. */
const MEDIAN_KEYS = ['presentation.partialShare', 'motion.zeroStepFrames', 'motion.stepCv', 'raf.fps', 'input.sampleRateHz']

/**
 * Fold repeats into one result: summary metrics become median with min/max (the noise floor
 * `perf compare` uses), sections come from the run closest to the median, validity is the union.
 */
export const aggregateRuns = (kind: PerfRunResult['kind'], meta: PerfRunMeta, runs: MeasuredRun[], samples?: boolean): PerfRunResult => {
	const result = createRunResult(kind, meta)
	const repeats: PerfRunRepeat[] = runs.map((run, index) => ({ ...run.repeat, index: index + 1 }))
	const key = MEDIAN_KEYS.find((name) => repeats.every((run) => run.summary[name])) ?? null
	const ordered = key ? [...repeats].sort((a, b) => a.summary[key]!.value - b.summary[key]!.value) : repeats
	const representative = ordered[Math.floor((ordered.length - 1) / 2)]!

	const { index: _index, summary: _summary, validity: _validity, ...sections } = representative
	Object.assign(result, sections)
	result.validity = mergeValidity(repeats)

	if (repeats.length === 1) {
		result.summary = representative.summary
	} else {
		result.runs = repeats
		const names = new Set(repeats.flatMap((run) => Object.keys(run.summary)))
		for (const name of names) {
			const values = repeats.flatMap((run) => (run.summary[name] ? [run.summary[name]!] : []))
			const numbers = values.map((metric) => metric.value)
			const first = values[0]!
			const metric: PerfMetric = { value: median(numbers), unit: first.unit, better: first.better, min: Math.min(...numbers), max: Math.max(...numbers), repeats: numbers.length }
			result.summary[name] = metric
		}
	}

	const chosen = runs[repeats.indexOf(representative)]!
	if (samples) result.samples = toSamples(chosen.data)
	if (chosen.tracePid != null) result.meta.tracePid = chosen.tracePid
	if (chosen.traceWindowUs) result.meta.traceWindowUs = chosen.traceWindowUs
	if (chosen.traceFile) result.meta.traceFile = chosen.traceFile
	return result
}

const mergeValidity = (repeats: PerfRunRepeat[]): PerfValidity => {
	const reasons = new Map<string, PerfValidity['reasons'][number]>()
	const warnings = new Map<string, PerfValidity['warnings'][number]>()
	for (const run of repeats) {
		const suffix = repeats.length > 1 ? ` (run ${run.index})` : ''
		for (const reason of run.validity.reasons) if (!reasons.has(reason.code)) reasons.set(reason.code, { ...reason, message: reason.message + suffix })
		for (const warning of run.validity.warnings) if (!warnings.has(warning.code)) warnings.set(warning.code, warning)
	}
	return { valid: reasons.size === 0, reasons: [...reasons.values()], warnings: [...warnings.values()] }
}
