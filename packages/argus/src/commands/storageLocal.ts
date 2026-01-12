import type {
	StorageLocalResponse,
	StorageLocalGetResponse,
	StorageLocalSetResponse,
	StorageLocalRemoveResponse,
	StorageLocalListResponse,
	StorageLocalClearResponse,
	ErrorResponse,
} from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'

/** Options for storage local commands. */
export type StorageLocalOptions = {
	origin?: string
	json?: boolean
}

/** Execute the storage local get command. */
export const runStorageLocalGet = async (id: string, key: string, options: StorageLocalOptions): Promise<void> => {
	const response = await callStorageLocal(id, { action: 'get', key, origin: options.origin })
	if (!response) return

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
		return
	}

	const r = response as StorageLocalGetResponse
	process.stdout.write(r.value ?? 'null')
	process.stdout.write('\n')
}

/** Execute the storage local set command. */
export const runStorageLocalSet = async (
	id: string,
	key: string,
	value: string,
	options: StorageLocalOptions & { raw?: boolean },
): Promise<void> => {
	// If --json flag is passed for input parsing (not output), parse value as JSON
	// Note: --json on set means parse input as JSON, not output format
	// We need a separate flag for JSON output, but per spec --json on set is for input
	// Actually re-reading spec: --json on set means output JSON response
	// --raw means treat value as raw string (default)
	// If neither --raw nor --json: default is raw string

	const response = await callStorageLocal(id, { action: 'set', key, value, origin: options.origin })
	if (!response) return

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
		return
	}

	const r = response as StorageLocalSetResponse
	process.stdout.write(`Set ${r.key} on ${r.origin}\n`)
}

/** Execute the storage local remove command. */
export const runStorageLocalRemove = async (id: string, key: string, options: StorageLocalOptions): Promise<void> => {
	const response = await callStorageLocal(id, { action: 'remove', key, origin: options.origin })
	if (!response) return

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
		return
	}

	const r = response as StorageLocalRemoveResponse
	process.stdout.write(`Removed ${r.key} from ${r.origin}\n`)
}

/** Execute the storage local list command. */
export const runStorageLocalList = async (id: string, options: StorageLocalOptions): Promise<void> => {
	const response = await callStorageLocal(id, { action: 'list', origin: options.origin })
	if (!response) return

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
		return
	}

	const r = response as StorageLocalListResponse
	for (const key of r.keys) {
		process.stdout.write(key + '\n')
	}
}

/** Execute the storage local clear command. */
export const runStorageLocalClear = async (id: string, options: StorageLocalOptions): Promise<void> => {
	const response = await callStorageLocal(id, { action: 'clear', origin: options.origin })
	if (!response) return

	if (options.json) {
		process.stdout.write(JSON.stringify(response) + '\n')
		return
	}

	const r = response as StorageLocalClearResponse
	process.stdout.write(`Cleared ${r.cleared} item(s) from ${r.origin}\n`)
}

type StorageLocalRequestPayload = {
	action: 'get' | 'set' | 'remove' | 'list' | 'clear'
	key?: string
	value?: string
	origin?: string
}

const callStorageLocal = async (id: string, payload: StorageLocalRequestPayload): Promise<StorageLocalResponse | null> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return null
	}

	const url = `http://${watcher.host}:${watcher.port}/storage/local`
	try {
		const response = await fetchJson<StorageLocalResponse | ErrorResponse>(url, {
			method: 'POST',
			body: payload,
			timeoutMs: 10_000,
			returnErrorResponse: true,
		})

		if (!response.ok) {
			const err = response as ErrorResponse
			console.error(`Error: ${err.error.message}`)
			process.exitCode = 1
			return null
		}

		return response as StorageLocalResponse
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return null
	}
}

const formatError = (error: unknown): string => {
	if (!error) return 'unknown error'
	if (error instanceof Error) return error.message
	return String(error)
}
