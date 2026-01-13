import type {
	StorageLocalResponse,
	StorageLocalGetResponse,
	StorageLocalSetResponse,
	StorageLocalRemoveResponse,
	StorageLocalListResponse,
	StorageLocalClearResponse,
	ErrorResponse,
} from '@vforsh/argus-core'
import { removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for storage local commands. */
export type StorageLocalOptions = {
	origin?: string
	json?: boolean
	pruneDead?: boolean
}

/** Execute the storage local get command. */
export const runStorageLocalGet = async (id: string | undefined, key: string, options: StorageLocalOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await callStorageLocal(id, { action: 'get', key, origin: options.origin }, options, output)
	if (!response) return

	if (options.json) {
		output.writeJson(response)
		return
	}

	const r = response as StorageLocalGetResponse
	output.writeHuman(r.value ?? 'null')
}

/** Execute the storage local set command. */
export const runStorageLocalSet = async (
	id: string | undefined,
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

	const output = createOutput(options)
	const response = await callStorageLocal(id, { action: 'set', key, value, origin: options.origin }, options, output)
	if (!response) return

	if (options.json) {
		output.writeJson(response)
		return
	}

	const r = response as StorageLocalSetResponse
	output.writeHuman(`Set ${r.key} on ${r.origin}`)
}

/** Execute the storage local remove command. */
export const runStorageLocalRemove = async (id: string | undefined, key: string, options: StorageLocalOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await callStorageLocal(id, { action: 'remove', key, origin: options.origin }, options, output)
	if (!response) return

	if (options.json) {
		output.writeJson(response)
		return
	}

	const r = response as StorageLocalRemoveResponse
	output.writeHuman(`Removed ${r.key} from ${r.origin}`)
}

/** Execute the storage local list command. */
export const runStorageLocalList = async (id: string | undefined, options: StorageLocalOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await callStorageLocal(id, { action: 'list', origin: options.origin }, options, output)
	if (!response) return

	if (options.json) {
		output.writeJson(response)
		return
	}

	const r = response as StorageLocalListResponse
	for (const key of r.keys) {
		output.writeHuman(key)
	}
}

/** Execute the storage local clear command. */
export const runStorageLocalClear = async (id: string | undefined, options: StorageLocalOptions): Promise<void> => {
	const output = createOutput(options)
	const response = await callStorageLocal(id, { action: 'clear', origin: options.origin }, options, output)
	if (!response) return

	if (options.json) {
		output.writeJson(response)
		return
	}

	const r = response as StorageLocalClearResponse
	output.writeHuman(`Cleared ${r.cleared} item(s) from ${r.origin}`)
}

type StorageLocalRequestPayload = {
	action: 'get' | 'set' | 'remove' | 'list' | 'clear'
	key?: string
	value?: string
	origin?: string
}

const callStorageLocal = async (
	id: string | undefined,
	payload: StorageLocalRequestPayload,
	options: StorageLocalOptions,
	output: ReturnType<typeof createOutput>,
): Promise<StorageLocalResponse | null> => {
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return null
	}

	const { watcher } = resolved
	let registry = resolved.registry

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
			output.writeWarn(`Error: ${err.error.message}`)
			process.exitCode = 1
			return null
		}

		return response as StorageLocalResponse
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		if (options.pruneDead) {
			registry = await removeWatcherAndPersist(registry, watcher.id)
		}
		process.exitCode = 1
		return null
	}
}

const formatError = (error: unknown): string => {
	if (!error) return 'unknown error'
	if (error instanceof Error) return error.message
	return String(error)
}
