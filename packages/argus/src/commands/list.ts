import type { RegistryV1, StatusResponse, WatcherRecord } from 'argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatWatcherLine } from '../output/format.js'

export type ListOptions = {
	json?: boolean
}

export const runList = async (options: ListOptions): Promise<void> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watchers = Object.values(registry.watchers)
	if (watchers.length === 0) {
		if (options.json) {
			process.stdout.write(JSON.stringify([]))
		}
		return
	}

	const results: Array<{ watcher: WatcherRecord; status?: StatusResponse }> = []

	for (const watcher of watchers) {
		const url = `http://${watcher.host}:${watcher.port}/status`
		try {
			const status = await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
			results.push({ watcher, status })
		} catch (error) {
			console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			registry = await removeWatcherAndPersist(registry, watcher.id)
		}
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(results.map((entry) => entry.status?.watcher ?? entry.watcher)))
		return
	}

	for (const entry of results) {
		process.stdout.write(`${formatWatcherLine(entry.watcher, entry.status)}\n`)
	}
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
