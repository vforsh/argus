import type { StatusResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the watcher status command. */
export type WatcherStatusOptions = {
	json?: boolean
}

/** Execute the watcher status command. */
export const runWatcherStatus = async (id: string | undefined, options: WatcherStatusOptions): Promise<void> => {
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

	const url = `http://${watcher.host}:${watcher.port}/status`
	let status: StatusResponse
	try {
		status = await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
	} catch (error) {
		output.writeWarn(`unreachable ${watcher.id} ${watcher.host}:${watcher.port} (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(status)
		return
	}

	output.writeHuman(`ok ${watcher.id} ${watcher.host}:${watcher.port} pid=${status.pid} attached=${status.attached}`)
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
