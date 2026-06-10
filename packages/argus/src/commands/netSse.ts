import type { NetSseResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { formatSseSummary } from '../output/net.js'

export type NetSseOptions = NetCliListOptions & {
	json?: boolean
}

export const runNetSse = defineWatcherCommand<NetSseOptions, NetSseResponse>({
	build: (_args, options, output) => {
		const params = new URLSearchParams()
		const query = appendNetCommandParams(params, options)
		if (query.error) {
			output.writeWarn(query.error)
			process.exitCode = 2
			return null
		}
		return { path: '/net/sse', query: params, timeoutMs: 5_000 }
	},
	formatJson: (response) => response.streams,
	formatHuman: (response, { output }) => {
		for (const stream of response.streams) {
			output.writeHuman(formatSseSummary(stream))
		}
	},
})
