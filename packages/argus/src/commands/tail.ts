import type { TailResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the tail command. */
export type TailOptions = {
	json?: boolean
	jsonFull?: boolean
	levels?: string
	match?: string[]
	ignoreCase?: boolean
	caseSensitive?: boolean
	source?: string
	after?: string
	timeout?: string
	limit?: string
}

/** Execute the tail command for a watcher id. */
export const runTail = async (id: string | undefined, options: TailOptions): Promise<void> => {
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

		const url = `http://${watcher.host}:${watcher.port}/tail?${params.toString()}`
		let response: TailResponse
		try {
			response = await fetchJson<TailResponse>(url, { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			process.exitCode = 1
			return
		}

		if (response.events.length > 0) {
			for (const event of response.events) {
				if (options.jsonFull) {
					output.writeJsonLine({ watcher: watcher.id, event })
					continue
				}
				if (options.json) {
					const previewEvent = previewLogEvent(event)
					output.writeJsonLine({ watcher: watcher.id, event: previewEvent })
					continue
				}
				output.writeHuman(
					formatLogEvent(event, {
						includeTimestamps: watcher.includeTimestamps,
					}),
				)
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
