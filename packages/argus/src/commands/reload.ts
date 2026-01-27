import type { ReloadResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the reload command. */
export type ReloadOptions = {
	json?: boolean
	ignoreCache?: boolean
}

/** Execute the reload command for a watcher id. */
export const runReload = async (id: string | undefined, options: ReloadOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved

	const url = `http://${watcher.host}:${watcher.port}/reload`
	let response: ReloadResponse
	try {
		response = await fetchJson<ReloadResponse>(url, {
			method: 'POST',
			body: {
				ignoreCache: options.ignoreCache ?? false,
			},
			timeoutMs: 10_000,
		})
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reload (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`reloaded ${watcher.id}`)
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
