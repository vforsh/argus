import { readRegistry, removeWatcherEntry, setWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { WatcherRecord } from '@vforsh/argus-core'

/**
 * Ensure no live watcher is using the given ID.
 * If a stale entry exists (process dead), it is removed automatically.
 * Throws if a watcher with the same ID is already running.
 */
export const ensureUniqueWatcherId = async (id: string): Promise<void> => {
	const { registry } = await readRegistry()
	const existing = registry.watchers[id]
	if (!existing) {
		return
	}

	if (existing.pid != null && isProcessAlive(existing.pid)) {
		throw new Error(`Watcher "${id}" is already running (pid ${existing.pid}). Pick a different --id or stop the existing one first.`)
	}

	// Stale entry — clean it up
	await updateRegistry((reg) => removeWatcherEntry(reg, id))
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
