import type { NetClearResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'

export type NetClearOptions = {
	json?: boolean
}

export const runNetClear = async (id: string | undefined, options: NetClearOptions): Promise<void> => {
	const output = createOutput(options)
	const result = await requestWatcherAction<NetClearResponse>(
		{
			id,
			path: '/net/clear',
			method: 'POST',
			timeoutMs: 5_000,
		},
		output,
	)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	output.writeHuman(`cleared ${result.data.cleared} requests from ${result.watcher.id}`)
}
