import type { NetResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineReadCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { compactRequestSummary, formatNetworkRequest } from '../output/net.js'
import type { Output } from '../output/io.js'
import { pipedRowTail } from '../output/outputScope.js'
import { parseOutputShaping, shapeJsonRecords, writeHumanRecords, type OutputShaping, type OutputShapingOptions } from '../output/projection.js'

/** Options for the net command. */
export type NetOptions = NetCliListOptions &
	OutputShapingOptions & {
		json?: boolean
	}

/** Execute the net command for a watcher id. */
export const runNet = defineReadCommand<NetOptions, NetResponse, unknown, [], OutputShaping>({
	build: (_args, options, output) => buildNetPlan(options, output),
	formatJson: (response, { meta }) => shapeJsonRecords(response.requests.map(compactRequestSummary), 'requests', meta),
	formatHuman: (response, { output, meta, options }) => {
		const bounded = [options.limit, options.after, options.since].some((value) => value != null) || meta.maxChars !== undefined
		writeHumanRecords(response.requests, meta, formatNetworkRequest, output, pipedRowTail(bounded))
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
