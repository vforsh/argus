import type { NetTailResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatNetworkRequest } from '../output/format.js'
import { parseDurationMs } from '../time.js'

/** Options for the net tail command. */
export type NetTailOptions = {
	json?: boolean
	after?: string
	limit?: string
	timeout?: string
	since?: string
	grep?: string
}

/** Execute the net tail command for a watcher id. */
export const runNetTail = async (id: string, options: NetTailOptions): Promise<void> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

	let after = parseNumber(options.after) ?? 0
	const timeoutMs = parseNumber(options.timeout) ?? 25_000
	const limit = parseNumber(options.limit)
	const sinceTsResult = resolveSinceTs(options.since)
	if (sinceTsResult.error) {
		console.error(sinceTsResult.error)
		process.exitCode = 2
		return
	}
	const sinceTs = sinceTsResult.value
	const grep = normalizeQueryValue(options.grep)

	let running = true
	const stop = (): void => {
		running = false
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	while (running) {
		const params = new URLSearchParams()
		params.set('after', String(after))
		params.set('timeoutMs', String(timeoutMs))
		if (limit != null) {
			params.set('limit', String(limit))
		}
		if (sinceTs != null) {
			params.set('sinceTs', String(sinceTs))
		}
		if (grep) {
			params.set('grep', grep)
		}

		const url = `http://${watcher.host}:${watcher.port}/net/tail?${params.toString()}`
		let response: NetTailResponse
		try {
			response = await fetchJson<NetTailResponse>(url, { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			registry = await removeWatcherAndPersist(registry, watcher.id)
			process.exitCode = 1
			return
		}

		if (response.requests.length > 0) {
			for (const request of response.requests) {
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ watcher: watcher.id, request })}\n`)
					continue
				}
				process.stdout.write(`${formatNetworkRequest(request)}\n`)
			}
		}

		after = response.nextAfter
	}
}

const resolveSinceTs = (value?: string): { value: number | null; error?: string } => {
	if (!value) {
		return { value: null }
	}
	const duration = parseDurationMs(value)
	if (!duration) {
		return { value: null, error: `Invalid --since value: ${value}` }
	}
	return { value: Date.now() - duration }
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
