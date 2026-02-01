import type { TraceStartResponse, TraceStopResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { parseDurationMs } from '../time.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'

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

	const stop = await runTraceStopInternal(watcher, {}, output)
	if (!stop) {
		return
	}

	if (options.json) {
		output.writeJson({ start, stop })
		return
	}

	output.writeHuman(`Trace saved: ${stop.outFile}`)
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
	output.writeHuman(`Output: ${start.outFile}`)
}

/** Execute the trace stop command for a watcher id. */
export const runTraceStop = async (id: string | undefined, options: TraceStopOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const stop = await runTraceStopInternal(resolved.watcher, options, output)
	if (!stop) {
		return
	}

	if (options.json) {
		output.writeJson(stop)
		return
	}

	output.writeHuman(`Trace saved: ${stop.outFile}`)
}

const runTraceStartInternal = async (
	watcher: WatcherRecord,
	options: { out?: string; categories?: string; options?: string },
	output: ReturnType<typeof createOutput>,
): Promise<TraceStartResponse | null> => {
	const url = `http://${watcher.host}:${watcher.port}/trace/start`
	try {
		const response = await fetchJson<TraceStartResponse>(url, {
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
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return null
	}
}

const runTraceStopInternal = async (
	watcher: WatcherRecord,
	options: { traceId?: string },
	output: ReturnType<typeof createOutput>,
): Promise<TraceStopResponse | null> => {
	const url = `http://${watcher.host}:${watcher.port}/trace/stop`
	try {
		const response = await fetchJson<TraceStopResponse>(url, {
			method: 'POST',
			body: { traceId: options.traceId },
			timeoutMs: 20_000,
		})
		return response
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return null
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
