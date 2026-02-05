import { readRegistry, removeWatcherEntry, setWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { WatcherRecord } from '@vforsh/argus-core'

/**
 * Resolve a unique watcher ID. If the requested ID is taken by a live watcher,
 * appends `-2`, `-3`, etc. until a free slot is found.
 * Stale entries (dead process) are cleaned up automatically.
 * Returns the ID that should be used.
 */
export const resolveUniqueWatcherId = async (id: string): Promise<string> => {
	const { registry } = await readRegistry()
	const staleIds: string[] = []

	const isIdAvailable = (candidate: string): boolean => {
		const existing = registry.watchers[candidate]
		if (!existing) {
			return true
		}
		if (existing.pid == null || !isProcessAlive(existing.pid)) {
			staleIds.push(candidate)
			return true
		}
		return false
	}

	let resolvedId = id
	if (!isIdAvailable(id)) {
		let suffix = 2
		while (!isIdAvailable(`${id}-${suffix}`)) {
			suffix++
		}
		resolvedId = `${id}-${suffix}`
	}

	if (staleIds.length > 0) {
		await updateRegistry((reg) => {
			let next = reg
			for (const staleId of staleIds) {
				next = removeWatcherEntry(next, staleId)
			}
			return next
		})
	}

	return resolvedId
}

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Write watcher entry to registry (locked read-modify-write). */
export const announceWatcher = async (watcher: WatcherRecord): Promise<void> => {
	await updateRegistry((registry) => setWatcherEntry(registry, watcher))
}

/** Refresh watcher entry in registry. */
export const updateWatcherHeartbeat = async (watcher: WatcherRecord): Promise<void> => {
	await announceWatcher(watcher)
}

/** Remove watcher entry from registry by id (locked read-modify-write). */
export const removeWatcher = async (id: string): Promise<void> => {
	await updateRegistry((registry) => removeWatcherEntry(registry, id))
}

/** Periodically refresh registry entry until stopped. */
export const startRegistryHeartbeat = (getWatcher: () => WatcherRecord, intervalMs = 15_000): { stop: () => void } => {
	const timer = setInterval(() => {
		const watcher = getWatcher()
		watcher.updatedAt = Date.now()
		void updateWatcherHeartbeat(watcher)
	}, intervalMs)

	return {
		stop: () => clearInterval(timer),
	}
}
