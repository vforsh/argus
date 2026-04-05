import type { NetRequestResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { formatNetworkRequestDetail } from '../output/net.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'

export type NetShowOptions = {
	json?: boolean
}

export const runNetShow = async (id: string | undefined, request: string, options: NetShowOptions): Promise<void> => {
	const output = createOutput(options)
	const normalizedRequest = request.trim()
	if (!normalizedRequest) {
		output.writeWarn('request id is required')
		process.exitCode = 2
		return
	}

	const query = new URLSearchParams()
	const numericId = parseBufferId(normalizedRequest)
	if (numericId != null) {
		query.set('id', String(numericId))
	} else {
		query.set('requestId', normalizedRequest)
	}

	const result = await requestWatcherAction<NetRequestResponse>(
		{
			id,
			path: '/net/request',
			query,
			timeoutMs: 5_000,
		},
		output,
	)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data.request)
		return
	}

	for (const line of formatNetworkRequestDetail(result.data.request)) {
		output.writeHuman(line)
	}
}

const parseBufferId = (value: string): number | null => {
	if (!/^\d+$/.test(value)) {
		return null
	}

	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
