import { existsSync } from 'node:fs'
import type { ShutdownResponse, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
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
	/** Subset of `removedIds` that was still running from a deleted directory, and was shut down. */
	orphanedIds?: string[]
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

	// Independent reachability probes, so latency is one timeout rather than N.
	const reachability = await Promise.all(watchers.map(async (watcher) => ({ watcher, reachable: await checkWatcherReachable(watcher) })))

	// A watcher still running from a deleted worktree is reachable but serves a checkout nobody can
	// build or open anymore; it only clutters `list` and steals `@` selections.
	const orphanedIds: string[] = []
	for (const { watcher, reachable } of reachability) {
		if (!reachable) {
			removedIds.push(watcher.id)
			output.writeWarn(`${watcher.id}: unreachable`)
		} else if (isOrphaned(watcher)) {
			removedIds.push(watcher.id)
			orphanedIds.push(watcher.id)
			output.writeWarn(`${watcher.id}: working directory ${watcher.cwd} no longer exists`)
		} else {
			keptIds.push(watcher.id)
		}
	}
	const orphaned = orphanedIds.length > 0 ? { orphanedIds } : {}

	// Guard: nothing to remove
	if (removedIds.length === 0) {
		if (options.json) {
			output.writeJson({ keptIds, removedIds, dryRun: options.dryRun === true } satisfies PruneResult)
		} else {
			output.writeHuman('All watchers are reachable and their directories exist. Nothing to prune.')
		}
		return
	}

	// Persist changes unless dry-run
	if (options.dryRun) {
		if (options.json) {
			output.writeJson({ keptIds, removedIds, ...orphaned, dryRun: true } satisfies PruneResult)
		} else {
			output.writeHuman(`Would remove ${removedIds.length} watcher(s): ${removedIds.join(', ')}`)
		}
		return
	}

	await Promise.all(orphanedIds.map((id) => requestShutdown(registry.watchers[id])))
	await removeWatchersAndPersist(removedIds, undefined, registry.watchers)

	if (options.json) {
		output.writeJson({ keptIds, removedIds, ...orphaned, dryRun: false } satisfies PruneResult)
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

/** Extension watchers live in Chrome's NativeMessagingHosts directory, which always exists; this is for CDP watchers. */
const isOrphaned = (watcher: WatcherRecord): boolean => watcher.cwd != null && watcher.cwd !== '' && !existsSync(watcher.cwd)

/** Ask an orphaned watcher to exit (closing a Chrome it launched); its record is removed either way. */
const requestShutdown = async (watcher: WatcherRecord | undefined): Promise<void> => {
	if (!watcher) return
	try {
		await fetchJson<ShutdownResponse>(`http://${watcher.host}:${watcher.port}/shutdown`, { method: 'POST', timeoutMs: 2_000 })
	} catch {
		// Already gone or wedged: removing the record is still the right outcome.
	}
}
