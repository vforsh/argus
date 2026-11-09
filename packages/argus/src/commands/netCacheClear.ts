import type { NetCacheClearResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

export type NetCacheClearOptions = {
	json?: boolean
}

/** Execute `argus net cache clear <id>`. */
export const runNetCacheClear = defineWatcherCommand<NetCacheClearOptions, NetCacheClearResponse>({
	build: () => ({ path: '/net/cache/clear', method: 'POST', timeoutMs: 35_000 }),
	formatHuman: (_response, { output, watcher }) => {
		output.writeHuman(`cleared browser HTTP cache via ${watcher.id}`)
	},
})
