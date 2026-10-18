import fs from 'node:fs/promises'
import path from 'node:path'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { readInputRecording, recordingToSchedule, writeInputRecording } from '../perf/inputRecording.js'
import { installPageRecorder, type RecorderData } from '../perf/pageRecorder.js'
import { analyzeInput } from '../perf/analyzeSamples.js'
import { createTeardown } from '../perf/teardown.js'
import { waitWithProgress } from './perfCapture.js'
import { playSchedule } from './perfGesture.js'
import { PerfUsageError, parseArmOn, parseDurationFlag, parseNumberFlag, parsePointFlag, parseTriggers, reportPerfError } from './perfShared.js'

export type InputRecordOptions = {
	json?: boolean
	out?: string
	armOn?: string
	triggers?: string
	duration?: string
	timeout?: string
	badge?: boolean
}

/** `argus input record`: passively record a real gesture to a JSONL file for later replay. */
export const runInputRecord = async (id: string | undefined, options: InputRecordOptions): Promise<void> => {
	const output = createOutput(options)
	try {
		if (!options.out) throw new PerfUsageError('Missing --out <file.jsonl>')
		const arm = parseArmOn(options.armOn)
		const triggers = parseTriggers(options.triggers)
		const durationMs = parseDurationFlag(options.duration, '--duration', 7_000)
		const timeoutMs = parseDurationFlag(options.timeout, '--timeout', 60_000)

		const resolved = await resolveWatcherOrExit({ id }, output)
		if (!resolved) return
		const watcher = resolved.watcher

		// Teardown owns the uninstall, so Ctrl+C or an expired session budget still removes the recorder.
		const teardown = createTeardown()
		let data: RecorderData
		try {
			const recorder = await installPageRecorder(watcher, { arm, triggers, durationMs, badge: options.badge !== false, rawSamples: true })
			teardown.add(recorder.uninstall)
			await waitWithProgress(recorder, { arm, durationMs, timeoutMs, triggers }, output)
			data = await recorder.collect()
		} finally {
			await teardown.dispose()
		}

		const origin = data.startedAt ?? 0
		const events = data.inputs.map((event) => ({ ...event, t: Math.round((event.t - origin) * 1000) / 1000 }))
		const outFile = path.resolve(options.out)
		await fs.mkdir(path.dirname(outFile), { recursive: true })
		await writeInputRecording(
			outFile,
			{ recordedAt: new Date().toISOString(), url: data.url, viewport: data.viewport, durationMs: Math.round((data.endedAt ?? origin) - origin), events: events.length },
			events,
		)
		const input = analyzeInput(data)
		if (options.json) {
			output.writeJson({ outFile, events: events.length, input })
			return
		}
		output.writeHuman(`Recorded ${input.events} DOM events (${input.coalescedSamples} raw samples ≈ ${input.sampleRateHz} Hz) → ${outFile}`)
		output.writeHuman(`events per frame  0: ${input.eventsPerFrame[0]}  1: ${input.eventsPerFrame[1]}  2+: ${input.eventsPerFrame[2]}`)
	} catch (error) {
		reportPerfError(error, output)
	}
}

export type InputReplayOptions = {
	json?: boolean
	cadence?: string
	offset?: string
	scale?: string
	button?: string
	maxInFlight?: string
}

/** `argus input replay [id] <file>`: dispatch a recording with its original timing. */
export const runInputReplay = async (idOrFile: string, maybeFile: string | undefined, options: InputReplayOptions): Promise<void> => {
	const output = createOutput(options)
	try {
		const [id, file] = maybeFile == null ? [undefined, idOrFile] : [idOrFile, maybeFile]
		const cadence = options.cadence ?? 'original'
		if (cadence !== 'original' && cadence !== 'frame') throw new PerfUsageError(`Invalid --cadence ${cadence}; expected original or frame`)
		if (options.button && !['left', 'middle', 'right'].includes(options.button)) throw new PerfUsageError(`Invalid --button ${options.button}`)
		const recording = await readInputRecording(path.resolve(file))
		const events = recordingToSchedule(
			recording.events,
			{
				cadence,
				offset: parsePointFlag(options.offset, '--offset'),
				scale: parseNumberFlag(options.scale, '--scale', { min: 0.01 }),
				button: options.button as 'left' | 'middle' | 'right' | undefined,
			},
			recording.header.viewport?.height,
		)
		if (events.length === 0) throw new PerfUsageError(`${file} holds no replayable input`)

		const resolved = await resolveWatcherOrExit({ id }, output)
		if (!resolved) return
		const playback = await playSchedule(resolved.watcher, events, parseNumberFlag(options.maxInFlight, '--max-in-flight', { min: 1, max: 64, integer: true }))
		if (options.json) {
			output.writeJson({ file: path.resolve(file), cadence, playback })
			return
		}
		output.writeHuman(
			`Replayed ${playback.dispatched}/${playback.requested} events in ${(playback.durationMs / 1000).toFixed(2)} s (${playback.rateHz} Hz moves; lateness p95 ${playback.latenessMs.p95} ms)`,
		)
	} catch (error) {
		reportPerfError(error, output)
	}
}
