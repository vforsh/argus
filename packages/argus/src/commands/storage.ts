import type {
	OriginStorageType,
	StorageArea,
	StorageClearResponse,
	StorageGetResponse,
	StorageKeyMutationResponse,
	StorageListResponse,
	StorageClearOriginRequest,
	StorageClearOriginResponse,
	StorageRequest,
	StorageResponse,
} from '@vforsh/argus-core'
import { ORIGIN_STORAGE_TYPES } from '@vforsh/argus-core'
import { defineActionCommand, defineWatcherCommand, type WatcherCommandContext, type WatcherCommandRunner } from '../cli/defineWatcherCommand.js'

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

/** Options for `argus storage clear`. */
export type StorageClearOriginOptions = StorageOptions & {
	types?: string
	reload?: boolean
}

/**
 * Execute `argus storage clear [id]`: wipe the selected target's origin data (its partition, for a
 * partitioned iframe), optionally reloading. An action command, so `--reload --until …` works.
 */
export const runStorageClearOrigin = defineActionCommand<StorageClearOriginOptions, StorageClearOriginResponse, StorageClearOriginRequest>({
	build: (_args, options, output) => {
		const types = parseOriginStorageTypes(options.types)
		if (typeof types === 'string') {
			output.writeWarn(types)
			process.exitCode = 2
			return null
		}
		return {
			path: '/storage/clear',
			method: 'POST',
			body: { types, reload: options.reload ?? false, origin: options.origin },
			// Clearing and the optional reload each have their own watcher-side deadline (30s, 60s), plus transport headroom.
			timeoutMs: 100_000,
		}
	},
	formatHuman: (response, { output }) => {
		const reloaded = response.reloaded ? ' and reloaded' : ''
		const partition = response.storageKey === `${response.origin}/` ? '' : ` (partitioned storage key ${response.storageKey})`
		output.writeHuman(`cleared ${response.types.join(', ')} for ${response.origin}${partition}${reloaded}`)
	},
})

/** Parse `--types a,b` into storage types, or return a usage message. Absent means every type. */
const parseOriginStorageTypes = (raw: string | undefined): OriginStorageType[] | undefined | string => {
	if (raw == null) {
		return undefined
	}
	const types = raw
		.split(',')
		.map((type) => type.trim())
		.filter(Boolean)
	const expected = `expected comma-separated: ${ORIGIN_STORAGE_TYPES.join(', ')}`
	if (types.length === 0) {
		return `--types: empty list; ${expected}`
	}
	const unknown = types.find((type) => !(ORIGIN_STORAGE_TYPES as readonly string[]).includes(type))
	if (unknown != null) {
		return `--types: unknown type "${unknown}"; ${expected}`
	}
	return types as OriginStorageType[]
}
