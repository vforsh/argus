import type { LogsResponse } from '@vforsh/argus-core'
import { formatLogEvent } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
import { parseNumber, normalizeQueryValue } from '../cli/parse.js'
import { parseDurationMs } from '../time.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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
export const runLogs = async (id: string | undefined, options: LogsOptions): Promise<void> => {
	const output = createOutput(options)

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

	const result = await requestWatcherJson<LogsResponse>({
		id,
		path: '/logs',
		query: params,
		timeoutMs: 5_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (options.jsonFull) {
		output.writeJson(result.data.events)
		return
	}

	if (options.json) {
		const previewEvents = result.data.events.map((event) => previewLogEvent(event))
		output.writeJson(previewEvents)
		return
	}

	for (const event of result.data.events) {
		output.writeHuman(
			formatLogEvent(event, {
				includeTimestamps: result.watcher.includeTimestamps,
			}),
		)
	}
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
