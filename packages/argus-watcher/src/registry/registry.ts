import { removeWatcherEntry, setWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { WatcherRecord } from '@vforsh/argus-core'

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
