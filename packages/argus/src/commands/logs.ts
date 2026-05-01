import type { LogsResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { formatLogEvent } from '../output/format.js'
import type { Output } from '../output/io.js'
import { previewLogEvent } from '../output/preview.js'
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
export const runLogs = defineWatcherCommand<LogsOptions, LogsResponse>({
	isJson: (options) => options.jsonFull === true,
	build: (_args, options, output) => buildLogsPlan(options, output),
	formatJson: (response, { options }) => (options.jsonFull ? response.events : response.events.map((event) => previewLogEvent(event))),
	formatHuman: (response, { output, watcher }) => {
		for (const event of response.events) {
			output.writeHuman(
				formatLogEvent(event, {
					includeTimestamps: watcher.includeTimestamps,
				}),
			)
		}
	},
})

const buildLogsPlan = (options: LogsOptions, output: Output): WatcherRequestPlan | null => {
	const params = new URLSearchParams()
	appendAfterLimitParams(params, options)
	const filters = appendLogFilterParams(params, options)
	if (filters.error) {
		output.writeWarn(filters.error)
		process.exitCode = 2
		return null
	}
	const since = appendSinceParam(params, options.since)
	if (since.error) {
		output.writeWarn(since.error)
		process.exitCode = 2
		return null
	}

	return {
		path: '/logs',
		query: params,
		timeoutMs: 5_000,
	}
}
