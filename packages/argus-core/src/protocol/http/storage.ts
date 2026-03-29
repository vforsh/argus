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

/** Back-compat alias for the localStorage endpoint request. */
export type StorageLocalRequest = StorageRequest

/** Back-compat alias for the localStorage endpoint get response. */
export type StorageLocalGetResponse = StorageGetResponse

/** Back-compat alias for the localStorage endpoint set response. */
export type StorageLocalSetResponse = StorageKeyMutationResponse

/** Back-compat alias for the localStorage endpoint remove response. */
export type StorageLocalRemoveResponse = StorageKeyMutationResponse

/** Back-compat alias for the localStorage endpoint list response. */
export type StorageLocalListResponse = StorageListResponse

/** Back-compat alias for the localStorage endpoint clear response. */
export type StorageLocalClearResponse = StorageClearResponse

/** Back-compat alias for the localStorage endpoint response union. */
export type StorageLocalResponse = StorageResponse

/** Alias for the sessionStorage endpoint request. */
export type StorageSessionRequest = StorageRequest

/** Alias for the sessionStorage endpoint get response. */
export type StorageSessionGetResponse = StorageGetResponse

/** Alias for the sessionStorage endpoint set response. */
export type StorageSessionSetResponse = StorageKeyMutationResponse

/** Alias for the sessionStorage endpoint remove response. */
export type StorageSessionRemoveResponse = StorageKeyMutationResponse

/** Alias for the sessionStorage endpoint list response. */
export type StorageSessionListResponse = StorageListResponse

/** Alias for the sessionStorage endpoint clear response. */
export type StorageSessionClearResponse = StorageClearResponse

/** Alias for the sessionStorage endpoint response union. */
export type StorageSessionResponse = StorageResponse
