import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { optionalEnum, optionalNumber, readFields, requireObject } from '../schemaFields.js'
import type { ErrorDetail, Ok } from './errors.js'

/**
 * CPU throttle state.
 * Rate 1 = no throttle, 4 = 4x slowdown. Must be >= 1.
 */
export type ThrottleState = {
	rate: number
}

/** POST /throttle request payload. */
export type ThrottleRequest = { action: 'set'; rate: number } | { action: 'clear' }

/** POST /throttle response for the `set` action. */
export type ThrottleSetResponse = Ok<{
	attached: boolean
	applied: boolean
	state: ThrottleState | null
	error?: ErrorDetail | null
}>

/** POST /throttle response for the `clear` action. */
export type ThrottleClearResponse = Ok<{
	attached: boolean
	applied: boolean
	state: null
	error?: ErrorDetail | null
}>

/** GET /throttle response. */
export type ThrottleStatusResponse = Ok<{
	attached: boolean
	applied: boolean
	state: ThrottleState | null
	lastError?: ErrorDetail | null
}>

/** Actions accepted by POST /throttle. */
export const THROTTLE_ACTIONS = ['set', 'clear'] as const

/** Schema for POST /throttle request payloads. */
export const throttleRequestSchema = defineProtocolSchema<ThrottleRequest>((value) => {
	const invalid = requireObject<ThrottleRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, THROTTLE_ACTIONS),
		rate: (source, key) => optionalNumber(source, key, { min: 1 }),
	})
	if (!fields.ok) return fields
	const { action, rate } = fields.value

	if (action == null) {
		return invalidProtocolPayload(`action must be one of: ${THROTTLE_ACTIONS.join(', ')}`)
	}
	if (action === 'clear') {
		return validProtocolPayload({ action })
	}
	if (rate == null) {
		return invalidProtocolPayload('rate must be a finite number >= 1')
	}

	return validProtocolPayload({ action, rate })
})
