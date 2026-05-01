import type { NetResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { formatNetworkRequest } from '../output/net.js'
import type { Output } from '../output/io.js'

/** Options for the net command. */
export type NetOptions = NetCliListOptions & {
	json?: boolean
}

/** Execute the net command for a watcher id. */
export const runNet = defineWatcherCommand<NetOptions, NetResponse>({
	build: (_args, options, output) => buildNetPlan(options, output),
	formatJson: (response) => response.requests,
	formatHuman: (response, { output }) => {
		for (const request of response.requests) {
			output.writeHuman(formatNetworkRequest(request))
		}
	},
})

const buildNetPlan = (options: NetOptions, output: Output): WatcherRequestPlan | null => {
	const params = new URLSearchParams()
	const query = appendNetCommandParams(params, options)
	if (query.error) {
		output.writeWarn(query.error)
		process.exitCode = 2
		return null
	}

	return {
		path: '/net',
		query: params,
		timeoutMs: 5_000,
	}
}
