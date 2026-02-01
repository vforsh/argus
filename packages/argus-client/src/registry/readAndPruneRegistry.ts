import { DEFAULT_TTL_MS, pruneStaleWatchers, removeWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { RegistryV1 } from '@vforsh/argus-core'

type RegistryOptions = {
	registryPath?: string
	ttlMs?: number
}

/** Read + prune stale entries atomically (locked read-modify-write). */
export const readAndPruneRegistry = async (options: RegistryOptions = {}): Promise<RegistryV1> => {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	return updateRegistry((registry) => {
		const { registry: pruned } = pruneStaleWatchers(registry, Date.now(), ttlMs)
		return pruned
	}, options.registryPath)
}

/** Remove a watcher entry atomically (locked read-modify-write). */
export const removeWatcherAndPersist = async (id: string, registryPath?: string): Promise<RegistryV1> => {
	return updateRegistry((registry) => removeWatcherEntry(registry, id), registryPath)
}
