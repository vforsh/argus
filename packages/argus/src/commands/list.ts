import type { RegistryV1, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput } from '../output/io.js'

/** Options for the list command. */
export type ListOptions = {
	json?: boolean
	byCwd?: string
	pruneDead?: boolean
}

/** Execute the list command. */
export const runList = async (options: ListOptions): Promise<void> => {
	const output = createOutput(options)
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	let watchers = Object.values(registry.watchers)

	if (options.byCwd) {
		const substring = options.byCwd
		watchers = watchers.filter((watcher) => watcher.cwd && watcher.cwd.includes(substring))
	}

	if (watchers.length === 0) {
		if (options.json) {
			output.writeJson([])
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
			output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			if (options.pruneDead) {
				registry = await removeWatcherAndPersist(registry, watcher.id)
			} else {
				results.push({ watcher })
			}
		}
	}

	if (options.json) {
		output.writeJson(results.map((entry) => entry.status?.watcher ?? entry.watcher))
		return
	}

	for (const entry of results) {
		output.writeHuman(formatWatcherLine(entry.watcher, entry.status))
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
