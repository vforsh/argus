import type { ReloadResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

/** Options for the reload command. */
export type ReloadOptions = {
	json?: boolean
	ignoreCache?: boolean
}

/** Execute the reload command for a watcher id. */
export const runReload = defineWatcherCommand<ReloadOptions, ReloadResponse>({
	build: (_args, options) => ({
		path: '/reload',
		method: 'POST',
		body: { ignoreCache: options.ignoreCache ?? false },
		timeoutMs: 10_000,
	}),
	formatHuman: (_response, { output, watcher }) => {
		output.writeHuman(`reloaded ${watcher.id}`)
	},
})
