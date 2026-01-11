import { DEFAULT_TTL_MS, pruneStaleWatchers, readRegistry, removeWatcherEntry, writeRegistry } from '@vforsh/argus-core'
import type { RegistryV1 } from '@vforsh/argus-core'

type RegistryOptions = {
	registryPath?: string
	ttlMs?: number
}

export const readAndPruneRegistry = async (options: RegistryOptions = {}): Promise<RegistryV1> => {
	const { registry } = await readRegistry(options.registryPath)
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const { registry: pruned, removedIds } = pruneStaleWatchers(registry, Date.now(), ttlMs)
	if (removedIds.length > 0) {
		await writeRegistry(pruned, options.registryPath)
	}
	return pruned
}

export const removeWatcherAndPersist = async (registry: RegistryV1, id: string, registryPath?: string): Promise<RegistryV1> => {
	const next = removeWatcherEntry(registry, id)
	if (next === registry) {
		return registry
	}
	await writeRegistry(next, registryPath)
	return next
}
