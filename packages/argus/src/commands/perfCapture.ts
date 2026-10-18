import type { Output } from '../output/io.js'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { aggregateRuns, buildMeta, measureOnce } from '../perf/measure.js'
import { waitForRecorder, type PageRecorder } from '../perf/pageRecorder.js'
import { resolveTraceCategories, SCREENSHOT_CATEGORY } from '../perf/traceRun.js'
import { probeEnvironment, probeHost } from '../perf/validity.js'
import { emitRunResult, parseArmOn, parseClipFlag, parseDurationFlag, parseNumberFlag, parseTriggers, reportPerfError, resolveOutPath } from './perfShared.js'

export type PerfCaptureOptions = {
	json?: boolean
	out?: string
	armOn?: string
	triggers?: string
	duration?: string
	timeout?: string
	probe?: string
	/** `--trace [preset]`: true for the default `frames` preset, or a preset name. */
	trace?: boolean | string
	motion?: boolean
	clip?: string
	badge?: boolean
	keepTrace?: string
	allowHeadless?: boolean
	pid?: string
}

const DEFAULT_DURATION_MS = 7_000
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * `argus perf capture`: arm a passive recorder, block until a human gesture has been recorded,
 * and report it. The agent needs no "done" message: the command returns when the capture ends.
 */
export const runPerfCapture = async (id: string | undefined, options: PerfCaptureOptions): Promise<void> => {
	await runCaptureLike(id, options, 'capture')
}

/**
 * `argus perf motion`: on-screen displacement per presented frame. A capture whose trace always
 * includes per-frame screenshots; `--arm-on now` measures immediately (animations, autoplay).
 */
export const runPerfMotion = async (id: string | undefined, options: PerfCaptureOptions): Promise<void> => {
	await runCaptureLike(id, { ...options, motion: true, trace: options.trace ?? true }, 'motion')
}

const runCaptureLike = async (id: string | undefined, options: PerfCaptureOptions, kind: 'capture' | 'motion'): Promise<void> => {
	const output = createOutput(options)
	try {
		const arm = parseArmOn(options.armOn)
		const triggers = parseTriggers(options.triggers)
		const durationMs = parseDurationFlag(options.duration, '--duration', DEFAULT_DURATION_MS)
		const timeoutMs = parseDurationFlag(options.timeout, '--timeout', DEFAULT_TIMEOUT_MS)
		const preset = options.trace === true ? 'frames' : options.trace || undefined
		const categories = preset || options.motion ? resolveTraceCategories(preset ?? 'frames', undefined, options.motion ? [SCREENSHOT_CATEGORY] : [])! : null
		const clip = parseClipFlag(options.clip)

		const resolved = await resolveWatcherOrExit({ id }, output)
		if (!resolved) return
		const watcher = resolved.watcher
		const [env, host] = await Promise.all([probeEnvironment(watcher), probeHost()])

		const run = await measureOnce({
			watcher,
			env,
			host,
			recorder: { arm, triggers, durationMs, badge: options.badge !== false, rawSamples: true, probe: options.probe },
			traceCategories: categories,
			motion: options.motion ? { clip } : null,
			keepTraceAt: resolveOutPath(options.keepTrace),
			allowHeadless: options.allowHeadless,
			expectInput: arm === 'input',
			pid: parseNumberFlag(options.pid, '--pid', { integer: true }),
			drive: async (recorder) => {
				await waitWithProgress(recorder, { arm, durationMs, timeoutMs, triggers }, output)
				return undefined
			},
		})

		const meta = buildMeta(watcher, env, host, {
			command: `perf ${kind}`,
			options: { armOn: arm, triggers, durationMs, probe: options.probe, trace: preset ?? null, motion: options.motion === true, clip },
		})
		await emitRunResult(aggregateRuns(kind, meta, [run], Boolean(options.out)), options, output)
	} catch (error) {
		reportPerfError(error, output)
	}
}

/** Block until the recorder is done, telling the human (on stderr in --json mode) when to move. */
export const waitWithProgress = async (
	recorder: PageRecorder,
	options: { arm: string; durationMs: number; timeoutMs: number; triggers: readonly string[] },
	output: Output,
): Promise<void> => {
	let announced: string | null = null
	await waitForRecorder(recorder, {
		timeoutMs: options.timeoutMs,
		durationMs: options.durationMs,
		onProgress: (status) => {
			if (status.phase === announced) return
			announced = status.phase ?? null
			if (status.phase === 'armed') {
				output.writeHuman(`Armed: waiting for input (${options.triggers.join(', ')}) for up to ${Math.round(options.timeoutMs / 1000)} s…`)
			} else if (status.phase === 'recording') {
				output.writeHuman(`Recording for ${(options.durationMs / 1000).toFixed(1)} s…`)
			}
		},
	})
}
