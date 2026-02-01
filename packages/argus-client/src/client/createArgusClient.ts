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
import { fetchJson } from '../http/fetchJson.js'
import { previewLogEvent } from '../logs/previewLogEvent.js'
import { readAndPruneRegistry, removeWatcherAndPersist } from '../registry/readAndPruneRegistry.js'
import { parseDurationMs } from '../time/parseDurationMs.js'

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
				const url = buildStatusUrl(watcher.host, watcher.port)
				try {
					const status = await fetchJson<StatusResponse>(url, { timeoutMs: listTimeoutMs })
					results.push({ watcher, reachable: true, status })
				} catch (error) {
					const message = formatError(error)
					results.push({ watcher, reachable: false, error: message })
					await removeWatcherAndPersist(watcher.id, registryPath)
				}
			}

			return results
		},
		logs: async (watcherId: string, logsOptions: LogsOptions = {}): Promise<LogsResult> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const params = buildLogsParams(logsOptions)
			const url = buildLogsUrl(watcher.host, watcher.port, params)

			let response: LogsResponse
			try {
				response = await fetchJson<LogsResponse>(url, { timeoutMs: logsTimeoutMs })
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			const mode = logsOptions.mode ?? 'preview'
			const events = mode === 'full' ? response.events : response.events.map((event) => previewLogEvent(event))

			return {
				events,
				nextAfter: response.nextAfter,
			}
		},
		net: async (watcherId: string, netOptions: NetOptions = {}): Promise<NetResult> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const params = buildNetParams(netOptions)
			const url = buildNetUrl(watcher.host, watcher.port, params)

			let response: NetResponse
			try {
				response = await fetchJson<NetResponse>(url, { timeoutMs: logsTimeoutMs })
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			return {
				requests: response.requests,
				nextAfter: response.nextAfter,
			}
		},
		eval: async (watcherId: string, evalOptions: EvalOptions): Promise<EvalResult> => {
			if (!evalOptions || !evalOptions.expression || evalOptions.expression.trim() === '') {
				throw new Error('expression is required')
			}

			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const url = buildEvalUrl(watcher.host, watcher.port)
			const timeoutMs = evalOptions.timeoutMs ?? logsTimeoutMs
			let response: EvalResponse
			try {
				response = await fetchJson<EvalResponse>(url, {
					timeoutMs,
					method: 'POST',
					body: evalOptions,
				})
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			return {
				result: response.result,
				type: response.type,
				exception: response.exception,
			}
		},
		traceStart: async (watcherId: string, traceOptions: TraceStartOptions = {}): Promise<TraceStartResult> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const url = buildTraceStartUrl(watcher.host, watcher.port)
			let response: TraceStartResponse
			try {
				response = await fetchJson<TraceStartResponse>(url, {
					timeoutMs: 10_000,
					method: 'POST',
					body: traceOptions,
				})
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			return { traceId: response.traceId, outFile: response.outFile }
		},
		traceStop: async (watcherId: string, traceOptions: TraceStopOptions = {}): Promise<TraceStopResult> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const url = buildTraceStopUrl(watcher.host, watcher.port)
			let response: TraceStopResponse
			try {
				response = await fetchJson<TraceStopResponse>(url, {
					timeoutMs: 20_000,
					method: 'POST',
					body: traceOptions,
				})
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			return { outFile: response.outFile }
		},
		screenshot: async (watcherId: string, screenshotOptions: ScreenshotOptions = {}): Promise<ScreenshotResult> => {
			const registry = await readAndPruneRegistry({ registryPath, ttlMs })
			const watcher = registry.watchers[watcherId]
			if (!watcher) {
				throw new Error(`Watcher not found: ${watcherId}`)
			}

			const url = buildScreenshotUrl(watcher.host, watcher.port)
			let response: ScreenshotResponse
			try {
				response = await fetchJson<ScreenshotResponse>(url, {
					timeoutMs: logsTimeoutMs,
					method: 'POST',
					body: screenshotOptions,
				})
			} catch (error) {
				await removeWatcherAndPersist(watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

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

const buildStatusUrl = (host: string, port: number): string => `http://${host}:${port}/status`

const buildLogsUrl = (host: string, port: number, params: URLSearchParams): string => {
	const query = params.toString()
	return query ? `http://${host}:${port}/logs?${query}` : `http://${host}:${port}/logs`
}

const buildNetUrl = (host: string, port: number, params: URLSearchParams): string => {
	const query = params.toString()
	return query ? `http://${host}:${port}/net?${query}` : `http://${host}:${port}/net`
}

const buildEvalUrl = (host: string, port: number): string => `http://${host}:${port}/eval`

const buildTraceStartUrl = (host: string, port: number): string => `http://${host}:${port}/trace/start`

const buildTraceStopUrl = (host: string, port: number): string => `http://${host}:${port}/trace/stop`

const buildScreenshotUrl = (host: string, port: number): string => `http://${host}:${port}/screenshot`

const buildLogsParams = (options: LogsOptions): URLSearchParams => {
	const params = new URLSearchParams()
	const after = normalizeNonNegativeNumber('after', options.after)
	if (after != null) {
		params.set('after', String(after))
	}
	const limit = normalizeNonNegativeNumber('limit', options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}
	const levels = normalizeLevels(options.levels)
	if (levels) {
		params.set('levels', levels)
	}
	const match = normalizeMatch(options.match)
	if (match) {
		for (const pattern of match) {
			params.append('match', pattern)
		}
	}
	const matchCase = normalizeMatchCase(options.matchCase)
	if (matchCase) {
		params.set('matchCase', matchCase)
	}
	const source = normalizeQueryValue(options.source)
	if (source) {
		params.set('source', source)
	}
	const sinceTs = resolveSinceTs(options.since)
	if (sinceTs != null) {
		params.set('sinceTs', String(sinceTs))
	}
	return params
}

const buildNetParams = (options: NetOptions): URLSearchParams => {
	const params = new URLSearchParams()
	const after = normalizeNonNegativeNumber('after', options.after)
	if (after != null) {
		params.set('after', String(after))
	}
	const limit = normalizeNonNegativeNumber('limit', options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}
	const sinceTs = resolveSinceTs(options.since)
	if (sinceTs != null) {
		params.set('sinceTs', String(sinceTs))
	}
	const grep = normalizeQueryValue(options.grep)
	if (grep) {
		params.set('grep', grep)
	}
	return params
}
const normalizeLevels = (levels?: string | string[]): string | undefined => {
	if (levels == null) {
		return undefined
	}

	if (Array.isArray(levels)) {
		const normalized = levels.map((level) => level.trim()).filter(Boolean)
		if (normalized.length === 0) {
			return undefined
		}
		return normalized.join(',')
	}

	const trimmed = levels.trim()
	return trimmed ? trimmed : undefined
}

const normalizeMatch = (match?: string | string[]): string[] | undefined => {
	if (match == null) {
		return undefined
	}

	const values = Array.isArray(match) ? match : [match]
	const normalized = values.map((value) => value.trim())
	const invalid = normalized.find((value) => value.length === 0)
	if (invalid != null) {
		throw new Error('Invalid match value: empty pattern.')
	}
	return normalized
}

const normalizeMatchCase = (matchCase?: 'sensitive' | 'insensitive'): 'sensitive' | 'insensitive' | undefined => {
	if (matchCase == null) {
		return undefined
	}

	if (matchCase !== 'sensitive' && matchCase !== 'insensitive') {
		throw new Error(`Invalid matchCase value: ${matchCase}`)
	}

	return matchCase
}

const resolveSinceTs = (value?: string | number): number | undefined => {
	if (value == null) {
		return undefined
	}

	const durationMs = typeof value === 'number' ? normalizeNonNegativeNumber('since', value) : parseDurationOrThrow(value)
	if (durationMs == null) {
		return undefined
	}

	return Date.now() - durationMs
}

const normalizeQueryValue = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

const parseDurationOrThrow = (value: string): number => {
	const duration = parseDurationMs(value)
	if (duration == null) {
		throw new Error(`Invalid since value: ${value}`)
	}
	return duration
}

const normalizeNonNegativeNumber = (label: string, value?: number): number | undefined => {
	if (value == null) {
		return undefined
	}

	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${label} value: ${value}`)
	}

	return value
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
