import type { ReloadResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the reload command. */
export type ReloadOptions = {
	json?: boolean
	ignoreCache?: boolean
}

/** Execute the reload command for a watcher id. */
export const runReload = async (id: string | undefined, options: ReloadOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<ReloadResponse>({
		id,
		path: '/reload',
		method: 'POST',
		body: { ignoreCache: options.ignoreCache ?? false },
		timeoutMs: 10_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	output.writeHuman(`reloaded ${result.watcher.id}`)
}
