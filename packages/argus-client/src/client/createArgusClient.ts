import type { LogsResponse, RegistryV1, StatusResponse } from '@vforsh/argus-core'
import { DEFAULT_TTL_MS } from '@vforsh/argus-core'
import type { ArgusClient, ArgusClientOptions, ListOptions, ListResult, LogsOptions, LogsResult } from '../types.js'
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
			let nextRegistry = registry

			for (const watcher of watchers) {
				const url = buildStatusUrl(watcher.host, watcher.port)
				try {
					const status = await fetchJson<StatusResponse>(url, { timeoutMs: listTimeoutMs })
					results.push({ watcher, reachable: true, status })
				} catch (error) {
					const message = formatError(error)
					results.push({ watcher, reachable: false, error: message })
					nextRegistry = await removeWatcherAndPersist(nextRegistry, watcher.id, registryPath)
				}
			}

			return results
		},
		logs: async (watcherId: string, logsOptions: LogsOptions = {}): Promise<LogsResult> => {
			let registry = await readAndPruneRegistry({ registryPath, ttlMs })
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
				registry = await removeWatcherAndPersist(registry, watcher.id, registryPath)
				throw new Error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			}

			const mode = logsOptions.mode ?? 'preview'
			const events = mode === 'full' ? response.events : response.events.map((event) => previewLogEvent(event))

			return {
				events,
				nextAfter: response.nextAfter,
			}
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
	if (options.grep) {
		params.set('grep', options.grep)
	}
	const sinceTs = resolveSinceTs(options.since)
	if (sinceTs != null) {
		params.set('sinceTs', String(sinceTs))
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
