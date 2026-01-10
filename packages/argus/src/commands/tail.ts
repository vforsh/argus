import type { TailResponse } from 'argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'

/** Options for the tail command. */
export type TailOptions = {
	json?: boolean
	levels?: string
	grep?: string
	after?: string
	timeout?: string
	limit?: string
}

/** Execute the tail command for a watcher id. */
export const runTail = async (id: string, options: TailOptions): Promise<void> => {
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
		if (options.levels) {
			params.set('levels', options.levels)
		}
		if (options.grep) {
			params.set('grep', options.grep)
		}

		const url = `http://${watcher.host}:${watcher.port}/tail?${params.toString()}`
		let response: TailResponse
		try {
			response = await fetchJson<TailResponse>(url, { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			registry = await removeWatcherAndPersist(registry, watcher.id)
			process.exitCode = 1
			return
		}

		if (response.events.length > 0) {
			for (const event of response.events) {
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ watcher: watcher.id, event })}\n`)
					continue
				}
				process.stdout.write(`${formatLogEvent(event, watcher.id)}\n`)
			}
		}

		after = response.nextAfter
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
