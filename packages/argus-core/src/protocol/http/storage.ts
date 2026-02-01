/** Request payload for POST /storage/local. */
export type StorageLocalRequest = {
	/** The operation to perform. */
	action: 'get' | 'set' | 'remove' | 'list' | 'clear'
	/** Key for get/set/remove operations. */
	key?: string
	/** Value for set operation. */
	value?: string
	/** Optional origin to validate against page's current origin. */
	origin?: string
}

/** Response payload for POST /storage/local (get). */
export type StorageLocalGetResponse = {
	ok: true
	origin: string
	key: string
	exists: boolean
	value: string | null
}

/** Response payload for POST /storage/local (set). */
export type StorageLocalSetResponse = {
	ok: true
	origin: string
	key: string
}

/** Response payload for POST /storage/local (remove). */
export type StorageLocalRemoveResponse = {
	ok: true
	origin: string
	key: string
}

/** Response payload for POST /storage/local (list). */
export type StorageLocalListResponse = {
	ok: true
	origin: string
	keys: string[]
}

/** Response payload for POST /storage/local (clear). */
export type StorageLocalClearResponse = {
	ok: true
	origin: string
	cleared: number
}

/** Union of all storage local responses. */
export type StorageLocalResponse =
	| StorageLocalGetResponse
	| StorageLocalSetResponse
	| StorageLocalRemoveResponse
	| StorageLocalListResponse
	| StorageLocalClearResponse
