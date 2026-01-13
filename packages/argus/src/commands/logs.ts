import type { LogsResponse } from '@vforsh/argus-core'
import { removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
import { parseDurationMs } from '../time.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

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
	pruneDead?: boolean
}

/** Execute the logs command for a watcher id. */
export const runLogs = async (id: string | undefined, options: LogsOptions): Promise<void> => {
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

	const { watcher } = resolved
	let registry = resolved.registry

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
		output.writeWarn(normalizedMatch.error)
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
			output.writeWarn(`Invalid --since value: ${options.since}`)
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
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		if (options.pruneDead) {
			registry = await removeWatcherAndPersist(registry, watcher.id)
		}
		process.exitCode = 1
		return
	}

	if (options.jsonFull) {
		output.writeJson(response.events)
		return
	}

	if (options.json) {
		const previewEvents = response.events.map((event) => previewLogEvent(event))
		output.writeJson(previewEvents)
		return
	}

	for (const event of response.events) {
		output.writeHuman(
			formatLogEvent(event, {
				includeTimestamps: watcher.includeTimestamps,
			}),
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
