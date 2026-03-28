import type { TailResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { formatLogEvent } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
import { parseNumber } from '../cli/parse.js'
import { buildWatcherUrl, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { appendLogFilterParams } from '../watchers/queryParams.js'

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
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

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
		const filters = appendLogFilterParams(params, options)
		if (filters.error) {
			output.writeWarn(filters.error)
			process.exitCode = 2
			return
		}

		const url = buildWatcherUrl(watcher, '/tail', params)
		let response: TailResponse
		try {
			response = await fetchJson<TailResponse>(url, { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			output.writeWarn(formatWatcherTransportError(watcher, error))
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
