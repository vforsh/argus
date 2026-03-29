import type {
	ErrorResponse,
	StorageArea,
	StorageRequest,
	StorageResponse,
	StorageGetResponse,
	StorageKeyMutationResponse,
	StorageListResponse,
	StorageClearResponse,
} from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options shared by storage commands. */
export type StorageOptions = {
	origin?: string
	json?: boolean
}

/** Execute `argus storage <area> get`. */
export const runStorageGet = async (area: StorageArea, id: string | undefined, key: string, options: StorageOptions): Promise<void> => {
	await runStorageCommand<StorageGetResponse>(area, id, { action: 'get', key, origin: options.origin }, options, (response, output) => {
		output.writeHuman(response.value ?? 'null')
	})
}

/** Execute `argus storage <area> set`. */
export const runStorageSet = async (
	area: StorageArea,
	id: string | undefined,
	key: string,
	value: string,
	options: StorageOptions,
): Promise<void> => {
	await runStorageCommand<StorageKeyMutationResponse>(
		area,
		id,
		{ action: 'set', key, value, origin: options.origin },
		options,
		(response, output) => {
			output.writeHuman(`Set ${response.key} on ${response.origin}`)
		},
	)
}

/** Execute `argus storage <area> remove`. */
export const runStorageRemove = async (area: StorageArea, id: string | undefined, key: string, options: StorageOptions): Promise<void> => {
	await runStorageCommand<StorageKeyMutationResponse>(area, id, { action: 'remove', key, origin: options.origin }, options, (response, output) => {
		output.writeHuman(`Removed ${response.key} from ${response.origin}`)
	})
}

/** Execute `argus storage <area> list`. */
export const runStorageList = async (area: StorageArea, id: string | undefined, options: StorageOptions): Promise<void> => {
	await runStorageCommand<StorageListResponse>(area, id, { action: 'list', origin: options.origin }, options, (response, output) => {
		for (const key of response.keys) {
			output.writeHuman(key)
		}
	})
}

/** Execute `argus storage <area> clear`. */
export const runStorageClear = async (area: StorageArea, id: string | undefined, options: StorageOptions): Promise<void> => {
	await runStorageCommand<StorageClearResponse>(area, id, { action: 'clear', origin: options.origin }, options, (response, output) => {
		output.writeHuman(`Cleared ${response.cleared} item(s) from ${response.origin}`)
	})
}

const runStorageCommand = async <T extends StorageResponse>(
	area: StorageArea,
	id: string | undefined,
	payload: StorageRequest,
	options: StorageOptions,
	writeHuman: (response: T, output: Output) => void,
): Promise<void> => {
	const output = createOutput(options)
	const response = await callStorage(area, id, payload, output)
	if (!response) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	writeHuman(response as T, output)
}

const callStorage = async (
	area: StorageArea,
	id: string | undefined,
	payload: StorageRequest,
	output: ReturnType<typeof createOutput>,
): Promise<StorageResponse | null> => {
	const result = await requestWatcherJson<StorageResponse | ErrorResponse>({
		id,
		path: `/storage/${area}`,
		method: 'POST',
		body: payload,
		timeoutMs: 10_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	if (!result.data.ok) {
		output.writeWarn(`Error: ${(result.data as ErrorResponse).error.message}`)
		process.exitCode = 1
		return null
	}

	return result.data as StorageResponse
}
