import type { StatusResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the watcher status command. */
export type WatcherStatusOptions = {
	json?: boolean
}

/** Execute the watcher status command. */
export const runWatcherStatus = async (id: string | undefined, options: WatcherStatusOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<StatusResponse>({
		id,
		path: '/status',
		timeoutMs: 2_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	const { watcher, data: status } = result
	output.writeHuman(`ok ${watcher.id} ${watcher.host}:${watcher.port} pid=${status.pid} attached=${status.attached}`)
}
