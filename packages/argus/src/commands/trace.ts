import type { TraceStartResponse, TraceStopResponse, WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { fetchWatcherJson, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'

/** Options for the trace command (start + stop). */
export type TraceOptions = {
	json?: boolean
	duration?: string
	out?: string
	categories?: string
	options?: string
}

/** Options for the trace start command. */
export type TraceStartOptions = {
	json?: boolean
	out?: string
	categories?: string
	options?: string
}

/** Options for the trace stop command. */
export type TraceStopOptions = {
	json?: boolean
	traceId?: string
	out?: string
}

/** Execute trace start + stop with duration. */
export const runTrace = async (id: string | undefined, options: TraceOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.duration) {
		output.writeWarn('Missing --duration value')
		process.exitCode = 2
		return
	}

	const durationMs = parseDurationMs(options.duration)
	if (!durationMs) {
		output.writeWarn(`Invalid --duration value: ${options.duration}`)
		process.exitCode = 2
		return
	}

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const watcher = resolved.watcher

	const start = await runTraceStartInternal(watcher, options, output)
	if (!start) {
		return
	}

	await delay(durationMs)

	const stop = await runTraceStopInternal(watcher, { outFile: options.out }, output)
	if (!stop) {
		return
	}

	if (options.json) {
		output.writeJson({ start, stop })
		return
	}

	output.writeHuman(`Trace saved: ${stop.outFile} (${stop.eventCount} events, ${formatDurationMs(stop.durationMs)})`)
}

/** Execute the trace start command for a watcher id. */
export const runTraceStart = async (id: string | undefined, options: TraceStartOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const start = await runTraceStartInternal(resolved.watcher, options, output)
	if (!start) {
		return
	}

	if (options.json) {
		output.writeJson(start)
		return
	}

	output.writeHuman(`Trace started: ${start.traceId}`)
	output.writeHuman(`Session: ${start.sessionName}`)
	output.writeHuman(`Output: ${start.outFile}`)
}

/** Execute the trace stop command for a watcher id. */
export const runTraceStop = async (id: string | undefined, options: TraceStopOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const stop = await runTraceStopInternal(resolved.watcher, { traceId: options.traceId, outFile: options.out }, output)
	if (!stop) {
		return
	}

	if (options.json) {
		output.writeJson(stop)
		return
	}

	output.writeHuman(`Trace saved: ${stop.outFile} (${stop.eventCount} events, ${formatDurationMs(stop.durationMs)})`)
}

const runTraceStartInternal = async (
	watcher: WatcherRecord,
	options: { out?: string; categories?: string; options?: string },
	output: ReturnType<typeof createOutput>,
): Promise<TraceStartResponse | null> => {
	try {
		const response = await fetchWatcherJson<TraceStartResponse>(watcher, {
			path: '/trace/start',
			method: 'POST',
			body: {
				outFile: options.out,
				categories: options.categories,
				options: options.options,
			},
			timeoutMs: 10_000,
		})
		return response
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return null
	}
}

const runTraceStopInternal = async (
	watcher: WatcherRecord,
	options: { traceId?: string; outFile?: string },
	output: ReturnType<typeof createOutput>,
): Promise<TraceStopResponse | null> => {
	try {
		const response = await fetchWatcherJson<TraceStopResponse>(watcher, {
			path: '/trace/stop',
			method: 'POST',
			body: { traceId: options.traceId, outFile: options.outFile },
			timeoutMs: 20_000,
		})
		return response
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return null
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const formatDurationMs = (ms: number): string => `${(ms / 1000).toFixed(3)}s`
