import type {
	StorageArea,
	StorageClearResponse,
	StorageGetResponse,
	StorageKeyMutationResponse,
	StorageListResponse,
	StorageRequest,
	StorageResponse,
} from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherCommandContext, type WatcherCommandRunner } from '../cli/defineWatcherCommand.js'

/** Options shared by storage commands. */
export type StorageOptions = {
	origin?: string
	json?: boolean
}

/** Internal: storage area lifted into options so a single helper drives every variant. */
type StorageOptionsWithArea = StorageOptions & { area?: StorageArea }

/** Execute `argus storage <area> get`. */
export const runStorageGet = (area: StorageArea, id: string | undefined, key: string, options: StorageOptions): Promise<void> =>
	getRunner(id, key, { ...options, area })

/** Execute `argus storage <area> set`. */
export const runStorageSet = (area: StorageArea, id: string | undefined, key: string, value: string, options: StorageOptions): Promise<void> =>
	setRunner(id, key, value, { ...options, area })

/** Execute `argus storage <area> remove`. */
export const runStorageRemove = (area: StorageArea, id: string | undefined, key: string, options: StorageOptions): Promise<void> =>
	removeRunner(id, key, { ...options, area })

/** Execute `argus storage <area> list`. */
export const runStorageList = (area: StorageArea, id: string | undefined, options: StorageOptions): Promise<void> =>
	listRunner(id, { ...options, area })

/** Execute `argus storage <area> clear`. */
export const runStorageClear = (area: StorageArea, id: string | undefined, options: StorageOptions): Promise<void> =>
	clearRunner(id, { ...options, area })

/**
 * Build a runner for one storage command. Bakes in the shared HTTP shape
 * (`POST /storage/<area>` with a 10s timeout); callers supply the per-action
 * payload and human formatter.
 */
const storageRunner = <TArgs extends readonly unknown[], TResponse extends StorageResponse>(
	body: (args: TArgs, options: StorageOptionsWithArea) => StorageRequest,
	formatHuman: (response: TResponse, ctx: WatcherCommandContext<TArgs, StorageOptionsWithArea>) => void,
): WatcherCommandRunner<TArgs, StorageOptionsWithArea> =>
	defineWatcherCommand<StorageOptionsWithArea, TResponse, unknown, TArgs>({
		build: (args, options) => ({
			path: `/storage/${options.area}`,
			method: 'POST',
			body: body(args, options),
			timeoutMs: 10_000,
		}),
		formatHuman,
	})

const getRunner = storageRunner<[key: string], StorageGetResponse>(
	([key], { origin }) => ({ action: 'get', key, origin }),
	(response, { output }) => output.writeHuman(response.value ?? 'null'),
)

const setRunner = storageRunner<[key: string, value: string], StorageKeyMutationResponse>(
	([key, value], { origin }) => ({ action: 'set', key, value, origin }),
	(response, { output }) => output.writeHuman(`Set ${response.key} on ${response.origin}`),
)

const removeRunner = storageRunner<[key: string], StorageKeyMutationResponse>(
	([key], { origin }) => ({ action: 'remove', key, origin }),
	(response, { output }) => output.writeHuman(`Removed ${response.key} from ${response.origin}`),
)

const listRunner = storageRunner<[], StorageListResponse>(
	(_args, { origin }) => ({ action: 'list', origin }),
	(response, { output }) => {
		for (const key of response.keys) {
			output.writeHuman(key)
		}
	},
)

const clearRunner = storageRunner<[], StorageClearResponse>(
	(_args, { origin }) => ({ action: 'clear', origin }),
	(response, { output }) => output.writeHuman(`Cleared ${response.cleared} item(s) from ${response.origin}`),
)
