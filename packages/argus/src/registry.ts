import { DEFAULT_TTL_MS, pruneStaleWatchers, readRegistry, removeWatcherEntry, writeRegistry } from '@vforsh/argus-core'
import type { RegistryV1 } from '@vforsh/argus-core'

/** Read registry and emit warnings to stderr. */
export const loadRegistry = async (): Promise<RegistryV1> => {
	const { registry, warnings } = await readRegistry()
	for (const warning of warnings) {
		console.error(warning)
	}
	return registry
}

/** Prune stale entries and persist if changed. */
export const pruneRegistry = async (registry: RegistryV1, ttlMs = DEFAULT_TTL_MS): Promise<RegistryV1> => {
	const { registry: pruned, removedIds } = pruneStaleWatchers(registry, Date.now(), ttlMs)
	if (removedIds.length > 0) {
		await writeRegistry(pruned)
	}
	return pruned
}

/** Remove watcher entry and persist registry. */
export const removeWatcherAndPersist = async (registry: RegistryV1, id: string): Promise<RegistryV1> => {
	const next = removeWatcherEntry(registry, id)
	await writeRegistry(next)
	return next
}
