import { DEFAULT_TTL_MS, pruneStaleWatchers, readRegistry, removeWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { RegistryV1 } from '@vforsh/argus-core'

/** Read registry and emit warnings to stderr. */
export const loadRegistry = async (): Promise<RegistryV1> => {
	const { registry, warnings } = await readRegistry()
	for (const warning of warnings) {
		console.error(warning)
	}
	return registry
}

/** Prune stale entries atomically (locked read-modify-write) and return the pruned registry. */
export const pruneRegistry = async (ttlMs = DEFAULT_TTL_MS): Promise<RegistryV1> => {
	return updateRegistry((registry) => {
		const { registry: pruned } = pruneStaleWatchers(registry, Date.now(), ttlMs)
		return pruned
	})
}

/** Remove watcher entry atomically (locked read-modify-write) and return the updated registry. */
export const removeWatcherAndPersist = async (id: string): Promise<RegistryV1> => {
	return updateRegistry((registry) => removeWatcherEntry(registry, id))
}

/** Remove multiple watcher entries atomically (locked read-modify-write) and return the updated registry. */
export const removeWatchersAndPersist = async (ids: string[]): Promise<RegistryV1> => {
	if (ids.length === 0) {
		const { registry } = await readRegistry()
		return registry
	}
	return updateRegistry((registry) => {
		let next = registry
		for (const id of ids) {
			next = removeWatcherEntry(next, id)
		}
		return next
	})
}
