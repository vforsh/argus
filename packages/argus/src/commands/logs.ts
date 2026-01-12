import type { LogsResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'
import { previewLogEvent } from '../output/preview.js'
import { parseDurationMs } from '../time.js'

/** Options for the logs command. */
export type LogsOptions = {
	json?: boolean
	jsonFull?: boolean
	levels?: string
	match?: string[]
	ignoreCase?: boolean
	caseSensitive?: boolean
	source?: string
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
	const normalizedMatch = normalizeMatch(options.match)
	if (normalizedMatch.error) {
		console.error(normalizedMatch.error)
		process.exitCode = 2
		return
	}
	if (normalizedMatch.match) {
		for (const pattern of normalizedMatch.match) {
			params.append('match', pattern)
		}
	}
	const matchCase = resolveMatchCase(options)
	if (matchCase) {
		params.set('matchCase', matchCase)
	}
	const source = normalizeQueryValue(options.source)
	if (source) {
		params.set('source', source)
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

	if (options.jsonFull) {
		process.stdout.write(JSON.stringify(response.events))
		return
	}

	if (options.json) {
		const previewEvents = response.events.map((event) => previewLogEvent(event))
		process.stdout.write(JSON.stringify(previewEvents))
		return
	}

	for (const event of response.events) {
		process.stdout.write(
			`${formatLogEvent(event, {
				includeTimestamps: watcher.includeTimestamps,
			})}\n`,
		)
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

const normalizeMatch = (match?: string[]): { match?: string[]; error?: string } => {
	if (!match || match.length === 0) {
		return {}
	}

	const normalized = match.map((value) => value.trim())
	const invalid = normalized.find((value) => value.length === 0)
	if (invalid != null) {
		return { error: 'Invalid --match value: empty pattern.' }
	}

	return { match: normalized }
}

const resolveMatchCase = (options: { ignoreCase?: boolean; caseSensitive?: boolean }): 'sensitive' | 'insensitive' | undefined => {
	if (options.caseSensitive) {
		return 'sensitive'
	}
	if (options.ignoreCase) {
		return 'insensitive'
	}
	return undefined
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
