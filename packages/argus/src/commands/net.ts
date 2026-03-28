import type { NetResponse } from '@vforsh/argus-core'
import { formatNetworkRequest } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'
import { appendAfterLimitParams, appendNetFilterParams, appendSinceParam } from '../watchers/queryParams.js'

/** Options for the net command. */
export type NetOptions = {
	json?: boolean
	after?: string
	limit?: string
	since?: string
	grep?: string
}

/** Execute the net command for a watcher id. */
export const runNet = async (id: string | undefined, options: NetOptions): Promise<void> => {
	const output = createOutput(options)

	const params = new URLSearchParams()
	appendAfterLimitParams(params, options)
	appendNetFilterParams(params, options)
	const since = appendSinceParam(params, options.since)
	if (since.error) {
		output.writeWarn(since.error)
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<NetResponse>({
		id,
		path: '/net',
		query: params,
		timeoutMs: 5_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (options.json) {
		output.writeJson(result.data.requests)
		return
	}

	for (const request of result.data.requests) {
		output.writeHuman(formatNetworkRequest(request))
	}
}
