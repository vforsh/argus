import type { NetResponse } from '@vforsh/argus-core'
import { formatNetworkRequest } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { parseNumber, normalizeQueryValue } from '../cli/parse.js'
import { parseDurationMs } from '../time.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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
	const after = parseNumber(options.after)
	if (after != null) {
		params.set('after', String(after))
	}
	const limit = parseNumber(options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
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
	const grep = normalizeQueryValue(options.grep)
	if (grep) {
		params.set('grep', grep)
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
