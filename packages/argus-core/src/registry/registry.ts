import fs from 'node:fs/promises'
import path from 'node:path'
import { withRegistryLock } from './lock.js'
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
export const readRegistry = async (registryPath = getRegistryPath()): Promise<RegistryReadResult> => {
	const warnings: string[] = []
	let raw: string | null = null

	try {
		raw = await fs.readFile(registryPath, 'utf8')
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
	await atomicWrite(registryPath, JSON.stringify(registry, null, 2))
}

/**
 * Atomically read-modify-write the registry under an exclusive lock.
 * The `updater` receives the current registry and must return the next state.
 * Returns the registry after the update has been persisted.
 */
export const updateRegistry = async (updater: (registry: RegistryV1) => RegistryV1, registryPath = getRegistryPath()): Promise<RegistryV1> => {
	return withRegistryLock(async () => {
		const { registry } = await readRegistry(registryPath)
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

/** Remove watchers whose updatedAt exceeds TTL. */
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

	if (removedIds.length === 0) {
		return { registry, removedIds }
	}

	return {
		registry: {
			...registry,
			updatedAt: now,
			watchers,
		},
		removedIds,
	}
}

const atomicWrite = async (filePath: string, contents: string): Promise<void> => {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
	await fs.writeFile(tmpPath, contents, 'utf8')

	try {
		await fs.rename(tmpPath, filePath)
	} catch (error) {
		if (!isReplaceError(error)) {
			throw error
		}
		await fs.rm(filePath, { force: true })
		await fs.rename(tmpPath, filePath)
	}
}

const isReplaceError = (error: unknown): error is NodeJS.ErrnoException => {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false
	}

	const err = error as NodeJS.ErrnoException
	return err.code === 'EEXIST' || err.code === 'EPERM'
}

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException => {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false
	}

	const err = error as NodeJS.ErrnoException
	return err.code === 'ENOENT'
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
