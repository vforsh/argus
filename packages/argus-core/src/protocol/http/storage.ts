import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalEnum, optionalString, readFields, requireObject } from '../schemaFields.js'
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
