import type { NetResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatNetworkRequest } from '../output/format.js'
import { parseDurationMs } from '../time.js'

/** Options for the net command. */
export type NetOptions = {
	json?: boolean
	after?: string
	limit?: string
	since?: string
	grep?: string
}

/** Execute the net command for a watcher id. */
export const runNet = async (id: string, options: NetOptions): Promise<void> => {
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
	if (options.since) {
		const duration = parseDurationMs(options.since)
		if (!duration) {
			console.error(`Invalid --since value: ${options.since}`)
			process.exitCode = 2
			return
		}
		params.set('sinceTs', String(Date.now() - duration))
	}
	const grep = normalizeQueryValue(options.grep)
	if (grep) {
		params.set('grep', grep)
	}

	const url = `http://${watcher.host}:${watcher.port}/net?${params.toString()}`
	let response: NetResponse
	try {
		response = await fetchJson<NetResponse>(url, { timeoutMs: 5_000 })
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response.requests))
		return
	}

	for (const request of response.requests) {
		process.stdout.write(`${formatNetworkRequest(request)}\n`)
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

const normalizeQueryValue = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}

	return trimmed
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
