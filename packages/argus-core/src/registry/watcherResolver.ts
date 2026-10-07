import { DEFAULT_TTL_MS, readActiveRegistry, sameWatcherEndpoint } from './registry.js'
import type { RegistryV1, WatcherRecord } from './types.js'

/** Per-client/session discovery; no process-global cache or request replay. */
export type WatcherResolver = {
	/** Read a recent snapshot, coalescing concurrent reads. Force refresh at recovery boundaries. */
	snapshot: (refresh?: boolean) => Promise<RegistryV1>
	/** Forget a failed endpoint without discarding a newer snapshot installed by another request. */
	invalidate: (failed: WatcherRecord) => void
}

/**
 * Reuse discovery for at most 250ms, and never past a record's heartbeat TTL.
 * @param options Optional registry path/TTL; each returned resolver owns its cache.
 * @returns A resolver that refreshes after expiry/failure. The caller must not replay failed mutations.
 */
export const createWatcherResolver = (options: { registryPath?: string; ttlMs?: number } = {}): WatcherResolver => {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	let cached: RegistryV1 | undefined
	let expiresAt = 0
	let generation = 0
	let pending: Promise<RegistryV1> | undefined

	const snapshot = (refresh = false): Promise<RegistryV1> => {
		if (refresh) resetSnapshot()
		if (cached && Date.now() < expiresAt) return Promise.resolve(cached)
		if (pending) return pending
		const version = generation
		const reading = readActiveRegistry(options).then((registry) => {
			if (generation === version) {
				cached = registry
				expiresAt = Date.now() + 250
				for (const watcher of Object.values(registry.watchers)) expiresAt = Math.min(expiresAt, watcher.updatedAt + ttlMs)
			}
			return registry
		}).finally(() => {
			if (pending === reading) pending = undefined
		})
		pending = reading
		return reading
	}

	const resetSnapshot = (): void => {
		cached = undefined
		pending = undefined
		generation++
	}

	return {
		snapshot,
		invalidate: (failed) => {
			if (cached && !sameWatcherEndpoint(cached.watchers[failed.id], failed)) return
			resetSnapshot()
		},
	}
}
