import type {
	IndexedDbClearResponse,
	IndexedDbDeleteResponse,
	IndexedDbGetResponse,
	IndexedDbKey,
	IndexedDbListResponse,
	IndexedDbRequest,
	IndexedDbResponse,
	IndexedDbStoreInfo,
} from '@vforsh/argus-core'
import { INDEXEDDB_GET_MAX_LIMIT, INDEXEDDB_GET_MAX_SKIP } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { defineWatcherCommand, type WatcherCommandContext, type WatcherCommandRunner } from '../cli/defineWatcherCommand.js'
import { parsePositiveInt } from '../cli/parse.js'

/** Options shared by `argus storage indexeddb` commands. */
export type IndexedDbOptions = {
	origin?: string
	json?: boolean
}

/** Options for `argus storage indexeddb get`. */
export type IndexedDbGetOptions = IndexedDbOptions & {
	key?: string
	limit?: string
	skip?: string
}

/** Execute `argus storage indexeddb list`. */
export const runIndexedDbList = (id: string | undefined, options: IndexedDbOptions): Promise<void> => listRunner(id, options)

/** Execute `argus storage indexeddb get <db> <store>`. */
export const runIndexedDbGet = (id: string | undefined, database: string, store: string, options: IndexedDbGetOptions): Promise<void> =>
	getRunner(id, database, store, options)

/** Execute `argus storage indexeddb clear <db> [store]`. */
export const runIndexedDbClear = (id: string | undefined, database: string, store: string | undefined, options: IndexedDbOptions): Promise<void> =>
	clearRunner(id, database, store, options)

/** Execute `argus storage indexeddb delete <db>`. */
export const runIndexedDbDelete = (id: string | undefined, database: string, options: IndexedDbOptions): Promise<void> =>
	deleteRunner(id, database, options)

/** Build a runner for one IndexedDB command: `POST /storage/indexeddb` with a per-action body. */
const indexedDbRunner = <TArgs extends readonly unknown[], TOptions extends IndexedDbOptions, TResponse extends IndexedDbResponse>(
	body: (args: TArgs, options: TOptions, output: Output) => IndexedDbRequest | null,
	formatHuman: (response: TResponse, ctx: WatcherCommandContext<TArgs, TOptions>) => void,
): WatcherCommandRunner<TArgs, TOptions> =>
	defineWatcherCommand<TOptions, TResponse, unknown, TArgs>({
		build: (args, options, output) => {
			const request = body(args, options, output)
			// Headroom over the watcher's own 30s deadline (the page aborts its own work at 20s), so its diagnosis arrives before the transport gives up.
			return request && { path: '/storage/indexeddb', method: 'POST', body: request, timeoutMs: 40_000 }
		},
		formatHuman,
	})

const listRunner = indexedDbRunner<[], IndexedDbOptions, IndexedDbListResponse>(
	(_args, { origin }) => ({ action: 'list', origin }),
	(response, { output }) => {
		if (response.databases.length === 0) {
			output.writeWarn(`no IndexedDB databases on ${response.origin}`)
			return
		}
		for (const db of response.databases) {
			output.writeHuman(`${db.name} v${db.version}`)
			for (const store of db.stores) {
				output.writeHuman(`  ${formatStore(store)}`)
			}
		}
	},
)

const formatStore = (store: IndexedDbStoreInfo): string => {
	const parts = [store.name, `${store.entries} ${store.entries === 1 ? 'entry' : 'entries'}`]
	if (store.keyPath != null) parts.push(`keyPath=${Array.isArray(store.keyPath) ? store.keyPath.join(',') : store.keyPath}`)
	if (store.autoIncrement) parts.push('autoIncrement')
	if (store.indexes.length > 0) parts.push(`indexes=${store.indexes.join(',')}`)
	return parts.join('  ')
}

const getRunner = indexedDbRunner<[database: string, store: string], IndexedDbGetOptions, IndexedDbGetResponse>(
	([database, store], options, output) => {
		const limit = parsePositiveInt(options.limit)
		if (options.limit != null && (limit == null || limit > INDEXEDDB_GET_MAX_LIMIT)) {
			return usageError(output, `--limit must be an integer between 1 and ${INDEXEDDB_GET_MAX_LIMIT}`)
		}
		const skip = parsePositiveInt(options.skip, { allowZero: true })
		if (options.skip != null && (skip == null || skip > INDEXEDDB_GET_MAX_SKIP)) {
			return usageError(output, `--skip must be an integer between 0 and ${INDEXEDDB_GET_MAX_SKIP}`)
		}
		const key = options.key == null ? undefined : parseIndexedDbKey(options.key)
		return { action: 'get', database, store, key, limit, skip, origin: options.origin }
	},
	(response, { output }) => {
		for (const entry of response.entries) {
			output.writeHuman(`${JSON.stringify(entry.key)}\t${JSON.stringify(entry.value)}`)
		}
		if (response.entries.length === 0) {
			output.writeWarn(`no entries in ${response.database}/${response.store}`)
		}
		if (response.hasMore) {
			output.writeWarn(`more entries: continue with --skip ${response.skip + response.entries.length}`)
		}
	},
)

const usageError = (output: Output, message: string): null => {
	output.writeWarn(message)
	process.exitCode = 2
	return null
}

/**
 * Read a `--key` value. JSON numbers and arrays address number and array keys (`--key 42`,
 * `--key '[1,"a"]'`); a JSON string forces a string key (`--key '"42"'`); anything else is a plain string.
 */
export const parseIndexedDbKey = (raw: string): IndexedDbKey => {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed === 'number' || typeof parsed === 'string' || Array.isArray(parsed)) {
			return parsed as IndexedDbKey
		}
	} catch {
		// Not JSON: a plain string key.
	}
	return raw
}

const clearRunner = indexedDbRunner<[database: string, store: string | undefined], IndexedDbOptions, IndexedDbClearResponse>(
	([database, store], { origin }) => ({ action: 'clear', database, store, origin }),
	(response, { output }) => {
		output.writeHuman(`cleared ${response.stores.length} store(s) in ${response.database} on ${response.origin}: ${response.stores.join(', ') || '-'}`)
	},
)

const deleteRunner = indexedDbRunner<[database: string], IndexedDbOptions, IndexedDbDeleteResponse>(
	([database], { origin }) => ({ action: 'delete', database, origin }),
	(response, { output }) => output.writeHuman(`deleted IndexedDB database ${response.database} on ${response.origin}`),
)
