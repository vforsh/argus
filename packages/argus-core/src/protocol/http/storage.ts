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

type StorageResponseBase = {
	ok: true
	origin: string
}

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
