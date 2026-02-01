import type {
	StorageLocalResponse,
	StorageLocalGetResponse,
	StorageLocalSetResponse,
	StorageLocalRemoveResponse,
	StorageLocalListResponse,
	StorageLocalClearResponse,
	ErrorResponse,
} from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for storage local commands. */
export type StorageLocalOptions = {
	origin?: string
	json?: boolean
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
	const result = await requestWatcherJson<StorageLocalResponse | ErrorResponse>({
		id,
		path: '/storage/local',
		method: 'POST',
		body: payload,
		timeoutMs: 10_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	const response = result.data
	if (!response.ok) {
		const err = response as ErrorResponse
		output.writeWarn(`Error: ${err.error.message}`)
		process.exitCode = 1
		return null
	}

	return response as StorageLocalResponse
}
