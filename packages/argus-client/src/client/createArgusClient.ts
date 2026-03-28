import type {
	EvalResponse,
	LogsResponse,
	NetResponse,
	RegistryV1,
	ScreenshotResponse,
	StatusResponse,
	TraceStartResponse,
	TraceStopResponse,
} from '@vforsh/argus-core'
import { DEFAULT_TTL_MS } from '@vforsh/argus-core'
import type {
	ArgusClient,
	ArgusClientOptions,
	EvalOptions,
	EvalResult,
	ListOptions,
	ListResult,
	LogsOptions,
	LogsResult,
	NetOptions,
	NetResult,
	ScreenshotOptions,
	ScreenshotResult,
	TraceStartOptions,
	TraceStartResult,
	TraceStopOptions,
	TraceStopResult,
} from '../types.js'
import { previewLogEvent } from '../logs/previewLogEvent.js'
import { readAndPruneRegistry } from '../registry/readAndPruneRegistry.js'
import { buildLogsParams, buildNetParams } from './queryParams.js'
import { requestWatcher } from './watcherRequest.js'

/**
 * Create an Argus client for list/logs queries.
 * Throws on invalid input, missing watcher, or unreachable watcher.
 * Note: list/logs prune stale registry entries and remove unreachable watchers.
 */
export const createArgusClient = (options: ArgusClientOptions = {}): ArgusClient => {
	const registryPath = options.registryPath
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const listTimeoutMs = options.timeoutMs ?? 2_000
	const logsTimeoutMs = options.timeoutMs ?? 5_000

	return {
		list: async (listOptions: ListOptions = {}): Promise<ListResult[]> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const byCwd = normalizeByCwd(listOptions.byCwd)
			const watchers = byCwd ? filterByCwd(registry, byCwd) : Object.values(registry.watchers)

			if (watchers.length === 0) {
				return []
			}

			const results: ListResult[] = []

			for (const watcher of watchers) {
				try {
					const { data: status } = await requestWatcher<StatusResponse>({ registryPath, ttlMs }, watcher.id, {
						path: '/status',
						timeoutMs: listTimeoutMs,
					})
					results.push({ watcher, reachable: true, status })
				} catch (error) {
					results.push({ watcher, reachable: false, error: formatError(error) })
				}
			}

			return results
		},
		logs: async (watcherId: string, logsOptions: LogsOptions = {}): Promise<LogsResult> => {
			const params = buildLogsParams(logsOptions)
			const { data: response } = await requestWatcher<LogsResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/logs',
				query: params,
				timeoutMs: logsTimeoutMs,
			})

			const mode = logsOptions.mode ?? 'preview'
			const events = mode === 'full' ? response.events : response.events.map((event) => previewLogEvent(event))

			return {
				events,
				nextAfter: response.nextAfter,
			}
		},
		net: async (watcherId: string, netOptions: NetOptions = {}): Promise<NetResult> => {
			const params = buildNetParams(netOptions)
			const { data: response } = await requestWatcher<NetResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/net',
				query: params,
				timeoutMs: logsTimeoutMs,
			})

			return {
				requests: response.requests,
				nextAfter: response.nextAfter,
			}
		},
		eval: async (watcherId: string, evalOptions: EvalOptions): Promise<EvalResult> => {
			if (!evalOptions || !evalOptions.expression || evalOptions.expression.trim() === '') {
				throw new Error('expression is required')
			}

			const timeoutMs = evalOptions.timeoutMs ?? logsTimeoutMs
			const { data: response } = await requestWatcher<EvalResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/eval',
				timeoutMs,
				method: 'POST',
				body: evalOptions,
			})

			return {
				result: response.result,
				type: response.type,
				exception: response.exception,
			}
		},
		traceStart: async (watcherId: string, traceOptions: TraceStartOptions = {}): Promise<TraceStartResult> => {
			const { data: response } = await requestWatcher<TraceStartResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/trace/start',
				timeoutMs: 10_000,
				method: 'POST',
				body: traceOptions,
			})

			return { traceId: response.traceId, sessionName: response.sessionName, outFile: response.outFile }
		},
		traceStop: async (watcherId: string, traceOptions: TraceStopOptions = {}): Promise<TraceStopResult> => {
			const { data: response } = await requestWatcher<TraceStopResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/trace/stop',
				timeoutMs: 20_000,
				method: 'POST',
				body: traceOptions,
			})

			return {
				sessionName: response.sessionName,
				outFile: response.outFile,
				eventCount: response.eventCount,
				durationMs: response.durationMs,
			}
		},
		screenshot: async (watcherId: string, screenshotOptions: ScreenshotOptions = {}): Promise<ScreenshotResult> => {
			const { data: response } = await requestWatcher<ScreenshotResponse>({ registryPath, ttlMs }, watcherId, {
				path: '/screenshot',
				timeoutMs: logsTimeoutMs,
				method: 'POST',
				body: screenshotOptions,
			})

			return { outFile: response.outFile, clipped: response.clipped }
		},
	}
}

const normalizeByCwd = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}

	return trimmed
}

const filterByCwd = (registry: RegistryV1, byCwd: string) =>
	Object.values(registry.watchers).filter((watcher) => watcher.cwd && watcher.cwd.includes(byCwd))

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
