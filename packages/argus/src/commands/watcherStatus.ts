import type { StatusResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

/** Options for the watcher status command. */
export type WatcherStatusOptions = {
	json?: boolean
}

/** Execute the watcher status command. */
export const runWatcherStatus = defineWatcherCommand<WatcherStatusOptions, StatusResponse>({
	build: () => ({ path: '/status', timeoutMs: 2_000 }),
	formatHuman: (status, { output, watcher }) => {
		const readinessSuffix = status.targetReady === false ? ' targetReady=false' : ''
		output.writeHuman(`ok ${watcher.id} ${watcher.host}:${watcher.port} pid=${status.pid} attached=${status.attached}${readinessSuffix}`)
	},
})
