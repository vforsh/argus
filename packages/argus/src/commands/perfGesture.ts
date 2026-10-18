import path from 'node:path'
import type { InputPlayEvent, InputPlayResponse, MouseButton, WatcherRecord } from '@vforsh/argus-core'
import { MOUSE_BUTTONS, delay } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { buildGestureSchedule, parseGesturePath, pathLength, samplePath, withModeKeys } from '../perf/gesture.js'
import { readInputRecording, recordingToSchedule } from '../perf/inputRecording.js'
import { aggregateRuns, buildMeta, measureOnce, type MeasuredRun } from '../perf/measure.js'
import { evalPageJson, postWatcherJson } from '../perf/pageEval.js'
import type { PlaybackSection } from '../perf/runResult.js'
import { resolveTraceCategories, SCREENSHOT_CATEGORY } from '../perf/traceRun.js'
import { probeEnvironment, probeHost } from '../perf/validity.js'
import {
	PerfUsageError,
	emitRunResult,
	parseClipFlag,
	parseDurationFlag,
	parseNumberFlag,
	parsePointFlag,
	reportPerfError,
	resolveOutPath,
} from './perfShared.js'

export type PerfGestureOptions = {
	json?: boolean
	out?: string
	at?: string
	selector?: string
	clip?: string
	button?: string
	pressKey?: string
	holdKey?: string
	path?: string
	speed?: string
	duration?: string
	rate?: string
	jitter?: string
	replay?: string
	cadence?: string
	offset?: string
	scale?: string
	repeat?: string
	warmup?: string
	motion?: boolean
	probe?: string
	preset?: string
	trace?: boolean
	keepTrace?: string
	allowHeadless?: boolean
	maxInFlight?: string
	pid?: string
}

const DEFAULT_PATH = 'line:-400,0'
const DEFAULT_SPEED_PX_S = 900
const DEFAULT_RATE_HZ = 250
/** Frames after the release, so the last update's presentation lands inside the window. */
const TAIL_MS = 300
const BETWEEN_RUNS_MS = 400

/**
 * `argus perf gesture`: the unattended gate. Plays a mouse gesture through the watcher's input
 * player while tracing (and optionally capturing per-frame screenshots), then writes one run result.
 */
export const runPerfGesture = async (id: string | undefined, options: PerfGestureOptions): Promise<void> => {
	const output = createOutput(options)
	try {
		const plan = await planGesture(options)
		const resolved = await resolveWatcherOrExit({ id }, output)
		if (!resolved) return
		const watcher = resolved.watcher

		const [env, host] = await Promise.all([probeEnvironment(watcher), probeHost()])
		const start = await resolveStartPoint(watcher, options, env.viewport)
		const schedule = plan.buildSchedule(start)
		const categories = options.trace === false ? null : resolveTraceCategories(options.preset ?? 'frames', undefined, options.motion ? [SCREENSHOT_CATEGORY] : [])!
		const keepTrace = resolveOutPath(options.keepTrace)
		const clip = parseClipFlag(options.clip)

		for (let i = 0; i < plan.warmup; i++) {
			output.writeHuman(`Warmup ${i + 1}/${plan.warmup}…`)
			await playSchedule(watcher, schedule, plan.maxInFlight)
			await delay(BETWEEN_RUNS_MS)
		}

		const runs: MeasuredRun[] = []
		for (let i = 0; i < plan.repeat; i++) {
			if (plan.repeat > 1) output.writeHuman(`Run ${i + 1}/${plan.repeat}…`)
			runs.push(
				await measureOnce({
					watcher,
					env,
					host,
					recorder: { arm: 'manual', triggers: [], badge: false, rawSamples: true, probe: options.probe },
					traceCategories: categories,
					motion: options.motion ? { clip } : null,
					keepTraceAt: keepTrace && (plan.repeat > 1 ? suffixPath(keepTrace, `.run${i + 1}`) : keepTrace),
					allowHeadless: options.allowHeadless,
					expectInput: true,
					pid: parseNumberFlag(options.pid, '--pid', { integer: true }),
					drive: async (recorder) => {
						await recorder.start()
						const playback = await playSchedule(watcher, schedule, plan.maxInFlight)
						await delay(TAIL_MS)
						await recorder.stop()
						return playback
					},
				}),
			)
			if (i < plan.repeat - 1) await delay(BETWEEN_RUNS_MS)
		}

		const meta = buildMeta(watcher, env, host, {
			command: 'perf gesture',
			options: { ...plan.describe, start, button: plan.button, repeat: plan.repeat, warmup: plan.warmup, motion: options.motion === true, categories },
		})
		await emitRunResult(aggregateRuns('gesture', meta, runs), options, output)
	} catch (error) {
		reportPerfError(error, output)
	}
}

type GesturePlan = {
	button: MouseButton
	repeat: number
	warmup: number
	maxInFlight?: number
	describe: Record<string, unknown>
	buildSchedule: (start: { x: number; y: number }) => InputPlayEvent[]
}

const planGesture = async (options: PerfGestureOptions): Promise<GesturePlan> => {
	const button = (options.button ?? 'left') as MouseButton
	if (!(MOUSE_BUTTONS as readonly string[]).includes(button)) throw new PerfUsageError(`Invalid --button ${options.button}; expected left, middle or right`)
	const repeat = parseNumberFlag(options.repeat, '--repeat', { min: 1, max: 50, integer: true }) ?? 1
	const warmup = parseNumberFlag(options.warmup, '--warmup', { min: 0, max: 10, integer: true }) ?? 0
	const maxInFlight = parseNumberFlag(options.maxInFlight, '--max-in-flight', { min: 1, max: 64, integer: true })

	if (options.replay) {
		if (options.path) throw new PerfUsageError('--replay and --path are mutually exclusive')
		const cadence = options.cadence ?? 'original'
		if (cadence !== 'original' && cadence !== 'frame') throw new PerfUsageError(`Invalid --cadence ${cadence}; expected original or frame`)
		const recording = await readInputRecording(path.resolve(options.replay))
		const offset = parsePointFlag(options.offset, '--offset')
		const scale = parseNumberFlag(options.scale, '--scale', { min: 0.01 })
		const held = { pressKey: options.pressKey, holdKey: options.holdKey }
		return {
			button,
			repeat,
			warmup,
			maxInFlight,
			describe: { replay: options.replay, cadence, offset, scale },
			buildSchedule: () => {
				const events = recordingToSchedule(recording.events, { cadence, offset, scale, button: options.button ? button : undefined }, recording.header.viewport?.height)
				if (events.length === 0) throw new PerfUsageError(`${options.replay} holds no replayable input`)
				return withModeKeys(events, held)
			},
		}
	}

	const gesturePath = await parseGesturePath(options.path ?? DEFAULT_PATH)
	const rateHz = parseNumberFlag(options.rate, '--rate', { min: 60, max: 1000 }) ?? DEFAULT_RATE_HZ
	const jitterMs = parseNumberFlag(options.jitter, '--jitter', { min: 0, max: 100 })
	const length = pathLength(gesturePath)
	if (options.speed && options.duration) throw new PerfUsageError('--speed and --duration are mutually exclusive')
	const speed = parseNumberFlag(options.speed, '--speed', { min: 1 })
	const durationMs = options.duration ? parseDurationFlag(options.duration, '--duration') : (length / (speed ?? DEFAULT_SPEED_PX_S)) * 1000
	const samples = samplePath(gesturePath, { durationMs, rateHz, jitterMs })
	return {
		button,
		repeat,
		warmup,
		maxInFlight,
		describe: { path: options.path ?? DEFAULT_PATH, lengthPx: Math.round(length), durationMs: Math.round(durationMs), rateHz, jitterMs, pressKey: options.pressKey, holdKey: options.holdKey },
		buildSchedule: (start) => buildGestureSchedule({ start, samples, button, pressKey: options.pressKey, holdKey: options.holdKey }),
	}
}

const resolveStartPoint = async (
	watcher: WatcherRecord,
	options: PerfGestureOptions,
	viewport: { width: number; height: number },
): Promise<{ x: number; y: number }> => {
	const at = parsePointFlag(options.at, '--at')
	if (at) return at
	if (options.selector) {
		const center = await evalPageJson<{ x: number; y: number } | null>(
			watcher,
			`(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
		)
		if (!center) throw new PerfUsageError(`--selector ${options.selector} matched nothing`)
		return { x: Math.round(center.x), y: Math.round(center.y) }
	}
	const clip = parseClipFlag(options.clip)
	if (clip) return { x: Math.round(clip.x + clip.width / 2), y: Math.round(clip.y + clip.height / 2) }
	return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
}

/** Play a schedule through the watcher's input player and convert its stats. */
export const playSchedule = async (watcher: WatcherRecord, events: InputPlayEvent[], maxInFlight?: number): Promise<PlaybackSection> => {
	const lastMs = events.reduce((max, event) => Math.max(max, event.t), 0)
	const response = await postWatcherJson<InputPlayResponse>(watcher, '/input/play', { events, maxInFlight }, lastMs + 15_000)
	if (response.error) throw new Error(`input playback failed after ${response.dispatched}/${response.requested} events: ${response.error}`)
	return {
		requested: response.requested,
		dispatched: response.dispatched,
		durationMs: response.durationMs,
		rateHz: response.moveRateHz,
		latenessMs: response.lateness,
		ackMs: response.ackMs,
		inFlightStalls: response.inFlightStalls,
	}
}

const suffixPath = (file: string, suffix: string): string => {
	const ext = path.extname(file)
	return `${file.slice(0, file.length - ext.length)}${suffix}${ext}`
}
