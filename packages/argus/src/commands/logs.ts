import type { LogsResponse } from '@vforsh/argus-core'
import { formatLogEvent } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'
import { appendAfterLimitParams, appendLogFilterParams, appendSinceParam } from '../watchers/queryParams.js'

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
	appendAfterLimitParams(params, options)
	const filters = appendLogFilterParams(params, options)
	if (filters.error) {
		output.writeWarn(filters.error)
		process.exitCode = 2
		return
	}
	const since = appendSinceParam(params, options.since)
	if (since.error) {
		output.writeWarn(since.error)
		process.exitCode = 2
		return
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
