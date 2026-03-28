import type { NetResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { formatNetworkRequest } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the net command. */
export type NetOptions = NetCliListOptions & {
	json?: boolean
}

/** Execute the net command for a watcher id. */
export const runNet = async (id: string | undefined, options: NetOptions): Promise<void> => {
	const output = createOutput(options)

	const params = new URLSearchParams()
	const query = appendNetCommandParams(params, options)
	if (query.error) {
		output.writeWarn(query.error)
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
