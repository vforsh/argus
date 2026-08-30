import { DEFAULT_TTL_MS, readAndPruneRegistry, readRegistry } from '@vforsh/argus-core'
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
export const pruneRegistry = async (ttlMs = DEFAULT_TTL_MS): Promise<RegistryV1> => readAndPruneRegistry({ ttlMs })

// Registry mutation lives in argus-core so the CLI and the SDK cannot drift on a file they share.
export { removeWatcherAndPersist, removeWatchersAndPersist } from '@vforsh/argus-core'
