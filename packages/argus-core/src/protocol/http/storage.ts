import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import {
	compact,
	optionalBoolean,
	optionalEnum,
	optionalInteger,
	optionalString,
	optionalStringArray,
	readFields,
	requireObject,
} from '../schemaFields.js'
import type { Ok } from './errors.js'

/** Storage areas exposed by the watcher API. */
export type StorageArea = 'local' | 'session'

/** Supported operations for POST /storage/<area>. */
export type StorageAction = 'get' | 'set' | 'remove' | 'list' | 'clear'

/** Request payload for POST /storage/<area>. */
export type StorageRequest = {
	/** The operation to perform. */
	action: StorageAction
	/** Key for get/set/remove operations. */
	key?: string
	/** Value for set operation. */
	value?: string
	/** Optional origin to validate against page's current origin. */
	origin?: string
}

type StorageResponseBase = Ok<{
	origin: string
}>

/** Response payload for POST /storage/<area> (get). */
export type StorageGetResponse = StorageResponseBase & {
	key: string
	exists: boolean
	value: string | null
}

/** Response payload for POST /storage/<area> (set/remove). */
export type StorageKeyMutationResponse = StorageResponseBase & {
	key: string
}

/** Response payload for POST /storage/<area> (list). */
export type StorageListResponse = StorageResponseBase & {
	keys: string[]
}

/** Response payload for POST /storage/<area> (clear). */
export type StorageClearResponse = StorageResponseBase & {
	cleared: number
}

/** Union of all storage responses. */
export type StorageResponse = StorageGetResponse | StorageKeyMutationResponse | StorageListResponse | StorageClearResponse

/** Operations accepted by POST /storage/<area>. */
export const STORAGE_ACTIONS = ['get', 'set', 'remove', 'list', 'clear'] as const

/** Operations that address a single key. */
const KEYED_STORAGE_ACTIONS = new Set<StorageAction>(['get', 'set', 'remove'])

/** Schema for POST /storage/<area> request payloads. */
export const storageRequestSchema = defineProtocolSchema<StorageRequest>((value) => {
	const invalid = requireObject<StorageRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, STORAGE_ACTIONS),
		key: optionalString,
		value: optionalString,
		origin: optionalString,
	})
	if (!fields.ok) return fields
	const { action, key, value: entryValue, origin } = fields.value

	if (action == null) {
		return invalidProtocolPayload(`action must be one of: ${STORAGE_ACTIONS.join(', ')}`)
	}
	if (KEYED_STORAGE_ACTIONS.has(action) && !key) {
		return invalidProtocolPayload(`key is required for the ${action} action`)
	}
	if (action === 'set' && typeof entryValue !== 'string') {
		return invalidProtocolPayload('value is required for the set action')
	}

	return validProtocolPayload(compact({ action, key, value: entryValue, origin }))
})

// ============================================================
// IndexedDB: POST /storage/indexeddb
// ============================================================

/** Operations accepted by POST /storage/indexeddb. */
export const INDEXEDDB_ACTIONS = ['list', 'get', 'clear', 'delete'] as const

/** An IndexedDB operation: `list` databases, `get` store entries, `clear` stores, or `delete` a database. */
export type IndexedDbAction = (typeof INDEXEDDB_ACTIONS)[number]

/** An IndexedDB key Argus can address: a string, a number, or an array of keys. Date and binary keys are not addressable. */
export type IndexedDbKey = string | number | IndexedDbKey[]

/** Default and maximum page size for the `get` action. */
export const INDEXEDDB_GET_DEFAULT_LIMIT = 50
export const INDEXEDDB_GET_MAX_LIMIT = 1000
/** Maximum `skip` for the `get` action: `IDBCursor.advance` takes an unsigned 32-bit count. */
export const INDEXEDDB_GET_MAX_SKIP = 4_294_967_295

/** Request payload for POST /storage/indexeddb. */
export type IndexedDbRequest = {
	action: IndexedDbAction
	/** Database name. Required for get/clear/delete. May be `''`: IndexedDB allows empty names. */
	database?: string
	/** Object store name (may be `''`). Required for get; for clear, omit (not `''`) to clear every store in the database. */
	store?: string
	/** get: return only the entry with this exact primary key. */
	key?: IndexedDbKey
	/** get: page size (1–1000, default 50). */
	limit?: number
	/** get: entries to skip before the page starts (0–4294967295, default 0). */
	skip?: number
	/** Optional origin to validate against the selected target's origin. */
	origin?: string
}

/** One object store, as reported by the `list` action. */
export type IndexedDbStoreInfo = {
	name: string
	/** The store's key path: a property path, a list of paths, or null for out-of-line keys. */
	keyPath: string | string[] | null
	autoIncrement: boolean
	/** Entry count at the time of the request. */
	entries: number
	/** Index names, sorted. */
	indexes: string[]
}

/** One database, as reported by the `list` action. */
export type IndexedDbDatabaseInfo = {
	name: string
	version: number
	stores: IndexedDbStoreInfo[]
}

/** One store entry. Values are JSON projections: Date → ISO string, binary → `{ type, byteLength }`, Map/Set → arrays. */
export type IndexedDbEntry = {
	key: unknown
	value: unknown
}

type IndexedDbResponseBase = Ok<{ origin: string }>

/** Response payload for POST /storage/indexeddb (list). Databases and stores are sorted by name. */
export type IndexedDbListResponse = IndexedDbResponseBase & {
	databases: IndexedDbDatabaseInfo[]
}

/** Response payload for POST /storage/indexeddb (get). */
export type IndexedDbGetResponse = IndexedDbResponseBase & {
	database: string
	store: string
	entries: IndexedDbEntry[]
	skip: number
	/** True when entries remain past this page; continue with `skip + entries.length`. */
	hasMore: boolean
}

/** Response payload for POST /storage/indexeddb (clear). */
export type IndexedDbClearResponse = IndexedDbResponseBase & {
	database: string
	/** Stores that were cleared. */
	stores: string[]
}

/** Response payload for POST /storage/indexeddb (delete). */
export type IndexedDbDeleteResponse = IndexedDbResponseBase & {
	database: string
}

/** Union of all IndexedDB responses. */
export type IndexedDbResponse = IndexedDbListResponse | IndexedDbGetResponse | IndexedDbClearResponse | IndexedDbDeleteResponse

const isIndexedDbKey = (value: unknown): value is IndexedDbKey =>
	typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(isIndexedDbKey))

/** Schema for POST /storage/indexeddb request payloads. */
export const indexedDbRequestSchema = defineProtocolSchema<IndexedDbRequest>((value) => {
	const invalid = requireObject<IndexedDbRequest>(value)
	if (invalid) return invalid

	const source = value as Record<string, unknown>
	const fields = readFields(source, {
		action: (input, key) => optionalEnum(input, key, INDEXEDDB_ACTIONS),
		// Not optionalNonEmptyString: '' is a valid IndexedDB name, and dropping it would widen `clear <db> ''` to every store.
		database: optionalString,
		store: optionalString,
		limit: (input, key) => optionalInteger(input, key, { min: 1, max: INDEXEDDB_GET_MAX_LIMIT }),
		skip: (input, key) => optionalInteger(input, key, { min: 0, max: INDEXEDDB_GET_MAX_SKIP }),
		origin: optionalString,
	})
	if (!fields.ok) return fields
	const { action, database, store, limit, skip, origin } = fields.value

	if (action == null) {
		return invalidProtocolPayload(`action must be one of: ${INDEXEDDB_ACTIONS.join(', ')}`)
	}
	if (action !== 'list' && database == null) {
		return invalidProtocolPayload(`database is required for the ${action} action`)
	}
	if (action === 'get' && store == null) {
		return invalidProtocolPayload('store is required for the get action')
	}
	const key = source.key
	if (key != null && !isIndexedDbKey(key)) {
		return invalidProtocolPayload('key must be a string, a finite number, or an array of keys')
	}

	return validProtocolPayload(compact({ action, database, store, key: key ?? undefined, limit, skip, origin }))
})

// ============================================================
// Origin-wide reset: POST /storage/clear
// ============================================================

/**
 * Storage types accepted by POST /storage/clear, named as CDP `Storage.clearDataForOrigin` names them.
 * `local_storage` covers both localStorage and sessionStorage.
 */
export const ORIGIN_STORAGE_TYPES = [
	'all',
	'cookies',
	'local_storage',
	'indexeddb',
	'cache_storage',
	'service_workers',
	'file_systems',
	'shared_storage',
	'storage_buckets',
] as const

/** A storage type for POST /storage/clear. */
export type OriginStorageType = (typeof ORIGIN_STORAGE_TYPES)[number]

/** Request payload for POST /storage/clear. */
export type StorageClearOriginRequest = {
	/** Types to clear. Default: `['all']`. */
	types?: OriginStorageType[]
	/** Reload the page after clearing, so it boots from empty storage. */
	reload?: boolean
	/** Optional origin to validate against the selected target's origin. */
	origin?: string
}

/** Response payload for POST /storage/clear. */
export type StorageClearOriginResponse = Ok<{
	origin: string
	/** The storage key that was cleared: `<origin>/`, or a partitioned key for an iframe embedded cross-site. */
	storageKey: string
	types: OriginStorageType[]
	reloaded: boolean
	/** Set when `reload` ran; see `ReloadResponse.navigatedFrom`. */
	navigatedFrom?: string
}>

/** Schema for POST /storage/clear request payloads. */
export const storageClearOriginRequestSchema = defineProtocolSchema<StorageClearOriginRequest>((value) => {
	const invalid = requireObject<StorageClearOriginRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		types: optionalStringArray,
		reload: optionalBoolean,
		origin: optionalString,
	})
	if (!fields.ok) return fields
	const { types, reload, origin } = fields.value

	const unknownType = types?.find((type) => !(ORIGIN_STORAGE_TYPES as readonly string[]).includes(type))
	if (unknownType != null) {
		return invalidProtocolPayload(`unknown storage type "${unknownType}"; expected: ${ORIGIN_STORAGE_TYPES.join(', ')}`)
	}
	if (types?.length === 0) {
		return invalidProtocolPayload('types must not be empty')
	}

	return validProtocolPayload(compact({ types: types as OriginStorageType[] | undefined, reload, origin }))
})
