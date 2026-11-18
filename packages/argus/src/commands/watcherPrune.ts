import { existsSync } from 'node:fs'
import {
	pruneStaleWatchers,
	readRegistry,
	removeWatcherEntry,
	sameWatcherEndpoint,
	updateRegistry,
	type ShutdownResponse,
	type StatusResponse,
	type WatcherRecord,
} from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { matchesLabels, parseLabels } from '../watchers/labels.js'

/** Options for the watcher prune command. */
export type WatcherPruneOptions = {
	byCwd?: string
	/** `key=value` filters; only watchers carrying all of them are checked or removed. */
	label?: string[]
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

	const labels = parseLabels(options.label)
	if (!labels.ok) {
		output.writeWarn(labels.error)
		process.exitCode = 2
		return
	}

	// One lock-free snapshot. Nothing is written until the final removal, which touches only the
	// records reported here — so `--dry-run` leaves the file byte-identical and filters bound every change.
	const { registry } = await readRegistry()
	const live = pruneStaleWatchers(registry).registry.watchers
	const substring = options.byCwd?.trim()
	const watchers = Object.values(registry.watchers).filter(
		(watcher) => (!substring || watcher.cwd?.includes(substring)) && matchesLabels(watcher, labels.labels),
	)

	const keptIds: string[] = []
	let removedIds: string[] = []

	// Dead pid or expired heartbeat: nothing to probe, the record is just left over.
	const staleIds = new Set<string>()
	for (const watcher of watchers) {
		if (live[watcher.id]) continue
		staleIds.add(watcher.id)
		removedIds.push(watcher.id)
		output.writeWarn(`${watcher.id}: stale (process gone or heartbeat expired)`)
	}

	// Independent reachability probes, so latency is one timeout rather than N.
	const reachability = await Promise.all(
		watchers.filter((watcher) => live[watcher.id]).map(async (watcher) => ({ watcher, reachable: await checkWatcherReachable(watcher) })),
	)

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

	const unfiltered = !substring && Object.keys(labels.labels).length === 0
	if (!options.dryRun && (removedIds.length > 0 || unfiltered)) {
		await Promise.all(orphanedIds.map((id) => requestShutdown(registry.watchers[id])))
		const removed = await persistRemovals(removedIds, staleIds, registry.watchers, unfiltered)
		// A stale run whose heartbeat recovered during the probes keeps its record and is reported as kept.
		keptIds.push(...removedIds.filter((id) => !removed.includes(id)))
		removedIds = removed
	}

	if (options.json) {
		output.writeJson({ keptIds, removedIds, ...orphaned, dryRun: options.dryRun === true } satisfies PruneResult)
	} else if (watchers.length === 0) {
		output.writeHuman('No watchers to check.')
	} else if (removedIds.length === 0) {
		output.writeHuman('All watchers are live, reachable, and their directories exist. Nothing to prune.')
	} else {
		output.writeHuman(`${options.dryRun ? 'Would remove' : 'Removed'} ${removedIds.length} watcher(s): ${removedIds.join(', ')}`)
	}
}

/**
 * Remove the reported records in one locked update, re-checking under the lock: a replaced run is kept,
 * and so is a stale one whose heartbeat came back while other records were probed.
 * An unfiltered prune also drops expired id reservations.
 * @returns Ids actually removed.
 */
const persistRemovals = async (
	ids: string[],
	staleIds: Set<string>,
	observed: Record<string, WatcherRecord>,
	unfiltered: boolean,
): Promise<string[]> => {
	let removed: string[] = []
	await updateRegistry((current) => {
		const now = Date.now()
		const stillStale = new Set(pruneStaleWatchers(current, now).removedIds)
		removed = ids.filter((id) => sameWatcherEndpoint(current.watchers[id], observed[id]) && (!staleIds.has(id) || stillStale.has(id)))
		let next = removed.reduce((registry, id) => removeWatcherEntry(registry, id, now), current)
		if (unfiltered) {
			const reservations = pruneStaleWatchers({ ...next, watchers: {} }, now).registry.reservations
			if (reservations !== next.reservations) next = { ...next, updatedAt: now, reservations }
		}
		return next
	})
	return removed
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
