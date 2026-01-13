import type { StatusResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'

/** Options for the watcher status command. */
export type WatcherStatusOptions = {
	json?: boolean
}

/** Execute the watcher status command. */
export const runWatcherStatus = async (id: string, options: WatcherStatusOptions): Promise<void> => {
	const watcherId = id?.trim()
	if (!watcherId) {
		console.error('Watcher id is required.')
		process.exitCode = 2
		return
	}

	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[watcherId]
	if (!watcher) {
		console.error(`Watcher not found: ${watcherId}`)
		process.exitCode = 1
		return
	}

	const url = `http://${watcher.host}:${watcher.port}/status`
	let status: StatusResponse
	try {
		status = await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
	} catch (error) {
		console.error(`unreachable ${watcher.id} ${watcher.host}:${watcher.port} (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(`${JSON.stringify(status)}\n`)
		return
	}

	process.stdout.write(`ok ${watcher.id} ${watcher.host}:${watcher.port} pid=${status.pid} attached=${status.attached}\n`)
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
