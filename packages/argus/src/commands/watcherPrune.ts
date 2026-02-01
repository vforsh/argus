import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry, removeWatchersAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'

/** Options for the watcher prune command. */
export type WatcherPruneOptions = {
	byCwd?: string
	dryRun?: boolean
	json?: boolean
}

/** Result shape for JSON output. */
type PruneResult = {
	keptIds: string[]
	removedIds: string[]
	dryRun: boolean
}

/** Execute the watcher prune command. */
export const runWatcherPrune = async (options: WatcherPruneOptions): Promise<void> => {
	const output = createOutput(options)

	// Validate --by-cwd is not empty/whitespace
	if (options.byCwd !== undefined && options.byCwd.trim().length === 0) {
		output.writeWarn('Invalid --by-cwd value: empty or whitespace.')
		process.exitCode = 2
		return
	}

	const registry = await pruneRegistry()

	let watchers = Object.values(registry.watchers)

	// Filter by cwd if specified
	if (options.byCwd) {
		const substring = options.byCwd.trim()
		watchers = watchers.filter((watcher) => watcher.cwd && watcher.cwd.includes(substring))
	}

	// Guard: no watchers after filtering
	if (watchers.length === 0) {
		if (options.json) {
			output.writeJson({ keptIds: [], removedIds: [], dryRun: options.dryRun === true } satisfies PruneResult)
		} else {
			output.writeHuman('No watchers to check.')
		}
		return
	}

	const keptIds: string[] = []
	const removedIds: string[] = []

	// Check each watcher for reachability
	for (const watcher of watchers) {
		const reachable = await checkWatcherReachable(watcher)
		if (reachable) {
			keptIds.push(watcher.id)
		} else {
			removedIds.push(watcher.id)
			output.writeWarn(`${watcher.id}: unreachable`)
		}
	}

	// Guard: nothing to remove
	if (removedIds.length === 0) {
		if (options.json) {
			output.writeJson({ keptIds, removedIds, dryRun: options.dryRun === true } satisfies PruneResult)
		} else {
			output.writeHuman('All watchers are reachable. Nothing to prune.')
		}
		return
	}

	// Persist changes unless dry-run
	if (options.dryRun) {
		if (options.json) {
			output.writeJson({ keptIds, removedIds, dryRun: true } satisfies PruneResult)
		} else {
			output.writeHuman(`Would remove ${removedIds.length} watcher(s): ${removedIds.join(', ')}`)
		}
		return
	}

	await removeWatchersAndPersist(removedIds)

	if (options.json) {
		output.writeJson({ keptIds, removedIds, dryRun: false } satisfies PruneResult)
	} else {
		output.writeHuman(`Removed ${removedIds.length} watcher(s): ${removedIds.join(', ')}`)
	}
}

/** Check if a watcher is reachable via /status endpoint. */
const checkWatcherReachable = async (watcher: WatcherRecord): Promise<boolean> => {
	const url = `http://${watcher.host}:${watcher.port}/status`
	try {
		await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
		return true
	} catch {
		return false
	}
}
