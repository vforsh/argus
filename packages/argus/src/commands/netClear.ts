import type { NetClearResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

export type NetClearOptions = {
	json?: boolean
}

export const runNetClear = defineWatcherCommand<NetClearOptions, NetClearResponse>({
	build: () => ({ path: '/net/clear', method: 'POST', timeoutMs: 5_000 }),
	formatHuman: (response, { output, watcher }) => {
		output.writeHuman(`cleared ${response.cleared} requests from ${watcher.id}`)
	},
})
