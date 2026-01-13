import type { RegistryV1, TraceStartResponse, TraceStopResponse, WatcherRecord } from '@vforsh/argus-core'
import { removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the trace command (start + stop). */
export type TraceOptions = {
	json?: boolean
	duration?: string
	out?: string
	categories?: string
	options?: string
	pruneDead?: boolean
}

/** Options for the trace start command. */
export type TraceStartOptions = {
	json?: boolean
	out?: string
	categories?: string
	options?: string
	pruneDead?: boolean
}

/** Options for the trace stop command. */
export type TraceStopOptions = {
	json?: boolean
	traceId?: string
	pruneDead?: boolean
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

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	let registry = resolved.registry
	const watcher = resolved.watcher

	const start = await runTraceStartInternal(watcher, registry, options, output)
	if (!start) {
		return
	}

	await delay(durationMs)

	const stop = await runTraceStopInternal(watcher, registry, options, output)
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
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const start = await runTraceStartInternal(resolved.watcher, resolved.registry, options, output)
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
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const stop = await runTraceStopInternal(resolved.watcher, resolved.registry, options, output)
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
	registry: RegistryV1,
	options: { out?: string; categories?: string; options?: string; pruneDead?: boolean },
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
		if (options.pruneDead) {
			await removeWatcherAndPersist(registry, watcher.id)
		}
		process.exitCode = 1
		return null
	}
}

const runTraceStopInternal = async (
	watcher: WatcherRecord,
	registry: RegistryV1,
	options: { traceId?: string; pruneDead?: boolean },
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
		if (options.pruneDead) {
			await removeWatcherAndPersist(registry, watcher.id)
		}
		process.exitCode = 1
		return null
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
