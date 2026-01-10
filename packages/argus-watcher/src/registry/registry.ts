import { readRegistry, removeWatcherEntry, setWatcherEntry, writeRegistry } from 'argus-core'
import type { WatcherRecord } from 'argus-core'

export const announceWatcher = async (watcher: WatcherRecord): Promise<void> => {
	const { registry } = await readRegistry()
	const next = setWatcherEntry(registry, watcher)
	await writeRegistry(next)
}

export const updateWatcherHeartbeat = async (watcher: WatcherRecord): Promise<void> => {
	await announceWatcher(watcher)
}

export const removeWatcher = async (id: string): Promise<void> => {
	const { registry } = await readRegistry()
	const next = removeWatcherEntry(registry, id)
	await writeRegistry(next)
}

export const startRegistryHeartbeat = (getWatcher: () => WatcherRecord, intervalMs = 15_000): { stop: () => void } => {
	const timer = setInterval(() => {
		const watcher = getWatcher()
		watcher.updatedAt = Date.now()
		void updateWatcherHeartbeat(watcher)
	}, intervalMs)

	return {
		stop: () => clearInterval(timer)
	}
}
