import fs from 'node:fs/promises'
import path from 'node:path'
import { withRegistryLock } from './lock.js'
import { atomicWriteFile, isMissingFileError, readFileSnapshot } from './jsonFile.js'
import { getRegistryPath } from './paths.js'
import type { RegistryReadResult, RegistryV1, WatcherRecord } from './types.js'

/** Current registry schema version. */
export const REGISTRY_VERSION = 1

/** Default staleness threshold in ms. */
export const DEFAULT_TTL_MS = 60_000

/** Create a fresh empty registry object. */
export const createEmptyRegistry = (now = Date.now()): RegistryV1 => ({
	version: REGISTRY_VERSION,
	updatedAt: now,
	watchers: {},
})

/** Read registry file from disk with safe fallback + warnings. */
export const readRegistry = async (registryPath = getRegistryPath()): Promise<RegistryReadResult> => readRegistryFile(registryPath, true)

const readRegistryFile = async (registryPath: string, retryReplacement: boolean): Promise<RegistryReadResult> => {
	const warnings: string[] = []
	let raw: string | null = null

	try {
		raw = retryReplacement ? await readFileSnapshot(registryPath) : await fs.readFile(registryPath, 'utf8')
	} catch (error) {
		if (isMissingFileError(error)) {
			warnings.push('Registry file missing. No watchers registered yet.')
			return { registry: createEmptyRegistry(), warnings }
		}
		throw error
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		warnings.push('Registry file is not valid JSON. Ignoring contents.')
		return { registry: createEmptyRegistry(), warnings }
	}

	if (!isRegistryV1(parsed)) {
		warnings.push('Registry file version is not supported. Ignoring contents.')
		return { registry: createEmptyRegistry(), warnings }
	}

	return { registry: parsed, warnings }
}

/** Write registry to disk using atomic replacement. */
export const writeRegistry = async (registry: RegistryV1, registryPath = getRegistryPath()): Promise<void> => {
	const dir = path.dirname(registryPath)
	await fs.mkdir(dir, { recursive: true })
	await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2))
}

/**
 * Atomically read-modify-write the registry under an exclusive lock.
 * The `updater` receives the current registry and must return the next state.
 * Returns the registry after the update has been persisted.
 */
export const updateRegistry = async (updater: (registry: RegistryV1) => RegistryV1, registryPath = getRegistryPath()): Promise<RegistryV1> => {
	return withRegistryLock(async () => {
		// This writer already owns the lock, so a missing file is an initial registry, not a replacement gap.
		const { registry } = await readRegistryFile(registryPath, false)
		const next = updater(registry)
		if (next !== registry) {
			await writeRegistry(next, registryPath)
		}
		return next
	}, registryPath)
}

/** Return registry watchers as a list. */
export const listWatchers = (registry: RegistryV1): WatcherRecord[] => Object.values(registry.watchers)

/** Add or update a watcher entry. */
export const setWatcherEntry = (registry: RegistryV1, watcher: WatcherRecord, now = Date.now()): RegistryV1 => {
	const next: RegistryV1 = {
		...registry,
		updatedAt: now,
		watchers: {
			...registry.watchers,
			[watcher.id]: watcher,
		},
	}
	return next
}

/** Remove a watcher entry by id. */
export const removeWatcherEntry = (registry: RegistryV1, id: string, now = Date.now()): RegistryV1 => {
	if (!registry.watchers[id]) {
		return registry
	}

	const watchers = { ...registry.watchers }
	delete watchers[id]

	return {
		...registry,
		updatedAt: now,
		watchers,
	}
}

/** Remove watchers whose updatedAt exceeds TTL, and reservations older than TTL. */
export const pruneStaleWatchers = (
	registry: RegistryV1,
	now = Date.now(),
	ttlMs = DEFAULT_TTL_MS,
): { registry: RegistryV1; removedIds: string[] } => {
	const removedIds: string[] = []
	const watchers: Record<string, WatcherRecord> = {}

	for (const [id, watcher] of Object.entries(registry.watchers)) {
		if (now - watcher.updatedAt > ttlMs) {
			removedIds.push(id)
			continue
		}
		watchers[id] = watcher
	}

	const reservations = pruneStaleReservations(registry.reservations, now, ttlMs)
	if (removedIds.length === 0 && reservations === registry.reservations) {
		return { registry, removedIds }
	}

	return {
		registry: {
			...registry,
			updatedAt: now,
			watchers,
			reservations,
		},
		removedIds,
	}
}

const pruneStaleReservations = (reservations: RegistryV1['reservations'], now: number, ttlMs: number): RegistryV1['reservations'] => {
	if (!reservations) {
		return reservations
	}
	const kept = Object.entries(reservations).filter(([, reservation]) => now - reservation.reservedAt <= ttlMs)
	if (kept.length === Object.keys(reservations).length) {
		return reservations
	}
	return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

const isRegistryV1 = (value: unknown): value is RegistryV1 => {
	if (!value || typeof value !== 'object') {
		return false
	}

	const record = value as RegistryV1
	if (record.version !== REGISTRY_VERSION) {
		return false
	}

	if (!record.watchers || typeof record.watchers !== 'object') {
		return false
	}

	return typeof record.updatedAt === 'number'
}

/**
 * Read a lock-free snapshot and hide expired watchers/reservations locally. Never writes to disk.
 * Physical cleanup is explicit (`readAndPruneRegistry`); writers still use the exclusive lock.
 * @param options Registry path and heartbeat TTL (defaults to the shared registry and 60 seconds).
 * @returns Only live entries from one complete on-disk snapshot.
 */
export const readActiveRegistry = async (options: { registryPath?: string; ttlMs?: number } = {}): Promise<RegistryV1> => {
	const { registry } = await readRegistry(options.registryPath)
	return pruneStaleWatchers(registry, Date.now(), options.ttlMs ?? DEFAULT_TTL_MS).registry
}

/**
 * Read the registry, pruning heartbeat-stale entries in the same locked read-modify-write.
 *
 * Use for explicit maintenance. Ordinary discovery uses `readActiveRegistry` without taking a lock.
 */
export const readAndPruneRegistry = async (options: { registryPath?: string; ttlMs?: number } = {}): Promise<RegistryV1> => {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	return updateRegistry((registry) => pruneStaleWatchers(registry, Date.now(), ttlMs).registry, options.registryPath)
}

/**
 * Remove an entry under the writer lock. When `expected` is provided, a replaced run/endpoint is kept.
 * @param id Watcher id to remove.
 * @param registryPath Optional shared registry path.
 * @param expected Failed record; protects a newer registration from a late transport failure.
 * @returns The persisted registry, unchanged if the failed endpoint no longer owns the id.
 */
export const removeWatcherAndPersist = async (id: string, registryPath?: string, expected?: WatcherRecord): Promise<RegistryV1> =>
	updateRegistry((registry) => {
		if (expected && !sameWatcherEndpoint(registry.watchers[id], expected)) return registry
		return removeWatcherEntry(registry, id)
	}, registryPath)

/**
 * Compare run identity and HTTP endpoint, ignoring heartbeat-only changes to updatedAt.
 * @param a Current registration, or undefined if it has disappeared.
 * @param b Previously resolved registration.
 * @returns True only if both records address the same run on the same endpoint.
 */
export const sameWatcherEndpoint = (a: WatcherRecord | undefined, b: WatcherRecord): boolean =>
	!!a && a.id === b.id && a.ownerId === b.ownerId && a.startedAt === b.startedAt && a.host === b.host && a.port === b.port

/**
 * Remove several entries in one locked read-modify-write.
 * @param ids Watcher ids to remove.
 * @param registryPath Optional shared registry path.
 * @param expected Optional records observed before probing; replaced endpoints survive late failures.
 * @returns Persisted registry after removal, or the current snapshot when ids is empty.
 */
export const removeWatchersAndPersist = async (ids: string[], registryPath?: string, expected?: Record<string, WatcherRecord>): Promise<RegistryV1> => {
	if (ids.length === 0) {
		const { registry } = await readRegistry(registryPath)
		return registry
	}

	return updateRegistry((registry) => ids.reduce((next, id) => {
		if (expected && (!expected[id] || !sameWatcherEndpoint(next.watchers[id], expected[id]))) return next
		return removeWatcherEntry(next, id)
	}, registry), registryPath)
}
