import type { NetSseResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { requestWatcherCommandAction } from '../cli/defineWatcherCommand.js'
import { formatSseSummary } from '../output/net.js'
import { createOutput } from '../output/io.js'

export type NetSseOptions = NetCliListOptions & {
	json?: boolean
}

export const runNetSse = async (id: string | undefined, options: NetSseOptions): Promise<void> => {
	const output = createOutput(options)
	const params = new URLSearchParams()
	const query = appendNetCommandParams(params, options)
	if (query.error) {
		output.writeWarn(query.error)
		process.exitCode = 2
		return
	}

	const result = await requestWatcherCommandAction<NetSseResponse>({ id, path: '/net/sse', query: params, timeoutMs: 5_000 }, output)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data.streams)
		return
	}

	for (const stream of result.data.streams) {
		output.writeHuman(formatSseSummary(stream))
	}
}
