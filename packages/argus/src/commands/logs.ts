import type { LogsResponse } from 'argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'
import { parseDurationMs } from '../time.js'

/** Options for the logs command. */
export type LogsOptions = {
	json?: boolean
	levels?: string
	grep?: string
	since?: string
	after?: string
	limit?: string
}

/** Execute the logs command for a watcher id. */
export const runLogs = async (id: string, options: LogsOptions): Promise<void> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

	const params = new URLSearchParams()
	const after = parseNumber(options.after)
	if (after != null) {
		params.set('after', String(after))
	}
	const limit = parseNumber(options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}
	if (options.levels) {
		params.set('levels', options.levels)
	}
	if (options.grep) {
		params.set('grep', options.grep)
	}
	if (options.since) {
		const duration = parseDurationMs(options.since)
		if (!duration) {
			console.error(`Invalid --since value: ${options.since}`)
			process.exitCode = 2
			return
		}
		params.set('sinceTs', String(Date.now() - duration))
	}

	const url = `http://${watcher.host}:${watcher.port}/logs?${params.toString()}`
	let response: LogsResponse
	try {
		response = await fetchJson<LogsResponse>(url, { timeoutMs: 5_000 })
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response.events))
		return
	}

	for (const event of response.events) {
		process.stdout.write(`${formatLogEvent(event, watcher.id)}\n`)
	}
}

const parseNumber = (value?: string): number | null => {
	if (!value) {
		return null
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return null
	}

	return parsed
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
