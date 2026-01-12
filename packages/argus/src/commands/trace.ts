import type { TraceStartResponse, TraceStopResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { parseDurationMs } from '../time.js'

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
export const runTrace = async (id: string, options: TraceOptions): Promise<void> => {
	if (!options.duration) {
		console.error('Missing --duration value')
		process.exitCode = 2
		return
	}

	const durationMs = parseDurationMs(options.duration)
	if (!durationMs) {
		console.error(`Invalid --duration value: ${options.duration}`)
		process.exitCode = 2
		return
	}

	const start = await runTraceStartInternal(id, {
		out: options.out,
		categories: options.categories,
		options: options.options,
	})
	if (!start) {
		return
	}

	await delay(durationMs)

	const stop = await runTraceStopInternal(id, { traceId: start.traceId })
	if (!stop) {
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify({ start, stop }))
		return
	}

	process.stdout.write(`Trace saved: ${stop.outFile}\n`)
}

/** Execute the trace start command for a watcher id. */
export const runTraceStart = async (id: string, options: TraceStartOptions): Promise<void> => {
	const start = await runTraceStartInternal(id, options)
	if (!start) {
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(start))
		return
	}

	process.stdout.write(`Trace started: ${start.traceId}\n`)
	process.stdout.write(`Output: ${start.outFile}\n`)
}

/** Execute the trace stop command for a watcher id. */
export const runTraceStop = async (id: string, options: TraceStopOptions): Promise<void> => {
	const stop = await runTraceStopInternal(id, options)
	if (!stop) {
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(stop))
		return
	}

	process.stdout.write(`Trace saved: ${stop.outFile}\n`)
}

const runTraceStartInternal = async (
	id: string,
	options: { out?: string; categories?: string; options?: string },
): Promise<TraceStartResponse | null> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return null
	}

	const url = `http://${watcher.host}:${watcher.port}/trace/start`
	let response: TraceStartResponse
	try {
		response = await fetchJson<TraceStartResponse>(url, {
			method: 'POST',
			body: {
				outFile: options.out,
				categories: options.categories,
				options: options.options,
			},
			timeoutMs: 10_000,
		})
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return null
	}

	return response
}

const runTraceStopInternal = async (
	id: string,
	options: { traceId?: string },
): Promise<TraceStopResponse | null> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return null
	}

	const url = `http://${watcher.host}:${watcher.port}/trace/stop`
	let response: TraceStopResponse
	try {
		response = await fetchJson<TraceStopResponse>(url, {
			method: 'POST',
			body: { traceId: options.traceId },
			timeoutMs: 20_000,
		})
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return null
	}

	return response
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
