import { readRegistry, removeWatcherEntry, setWatcherEntry, writeRegistry } from '@vforsh/argus-core'
import type { WatcherRecord } from '@vforsh/argus-core'

/** Write watcher entry to registry. */
export const announceWatcher = async (watcher: WatcherRecord): Promise<void> => {
	const { registry } = await readRegistry()
	const next = setWatcherEntry(registry, watcher)
	await writeRegistry(next)
}

/** Refresh watcher entry in registry. */
export const updateWatcherHeartbeat = async (watcher: WatcherRecord): Promise<void> => {
	await announceWatcher(watcher)
}

/** Remove watcher entry from registry by id. */
export const removeWatcher = async (id: string): Promise<void> => {
	const { registry } = await readRegistry()
	const next = removeWatcherEntry(registry, id)
	await writeRegistry(next)
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
