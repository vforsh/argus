import type { NetResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { formatNetworkRequest } from '../output/net.js'
import type { Output } from '../output/io.js'
import { parseOutputShaping, shapeJsonRecords, writeHumanRecords, type OutputShaping, type OutputShapingOptions } from '../output/projection.js'

/** Options for the net command. */
export type NetOptions = NetCliListOptions &
	OutputShapingOptions & {
		json?: boolean
	}

/** Execute the net command for a watcher id. */
export const runNet = defineWatcherCommand<NetOptions, NetResponse, unknown, [], OutputShaping>({
	build: (_args, options, output) => buildNetPlan(options, output),
	formatJson: (response, { meta }) => shapeJsonRecords(response.requests, 'requests', meta),
	formatHuman: (response, { output, meta }) => {
		writeHumanRecords(response.requests, meta, formatNetworkRequest, output)
	},
})

const buildNetPlan = (options: NetOptions, output: Output): WatcherRequestPlan<OutputShaping> | null => {
	const shaping = parseOutputShaping(options, output)
	if (!shaping) return null

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
		meta: shaping,
	}
}
