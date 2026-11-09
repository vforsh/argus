import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalEnum, optionalNumber, optionalRecord, readFields, requireObject } from '../schemaFields.js'
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

/** GET /throttle response. The top-level `applied`/`state`/`lastError` describe the CPU throttle. */
export type ThrottleStatusResponse = Ok<{
	attached: boolean
	applied: boolean
	state: ThrottleState | null
	lastError?: ErrorDetail | null
	/** Network throttle. Absent on watchers that predate network throttling. */
	network?: {
		applied: boolean
		state: NetworkThrottleState | null
		lastError?: ErrorDetail | null
	}
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

/** Named network conditions accepted by `argus throttle net set --preset`. */
export const NETWORK_THROTTLE_PRESET_NAMES = ['fast-4g', 'slow-4g', '3g', 'offline'] as const

/** A named set of network conditions. */
export type NetworkThrottlePreset = (typeof NETWORK_THROTTLE_PRESET_NAMES)[number]

/**
 * Network throttle conditions.
 * A missing throughput cap means unlimited; `offline` fails every request regardless of the rest.
 */
export type NetworkThrottleState = {
	offline: boolean
	/** Latency added to every request, in milliseconds. 0 = none. */
	latencyMs: number
	/** Download cap in kilobits per second. Must be > 0. */
	downloadKbps?: number
	/** Upload cap in kilobits per second. Must be > 0. */
	uploadKbps?: number
	/** Preset the conditions were taken from; absent once any value was set by hand. */
	preset?: NetworkThrottlePreset
}

/** Conditions behind each preset. The 3G/4G values are the ones Chrome DevTools uses under the same names. */
export const NETWORK_THROTTLE_PRESETS: Record<NetworkThrottlePreset, NetworkThrottleState> = {
	'fast-4g': { offline: false, latencyMs: 165, downloadKbps: 8100, uploadKbps: 1350, preset: 'fast-4g' },
	'slow-4g': { offline: false, latencyMs: 562.5, downloadKbps: 1440, uploadKbps: 675, preset: 'slow-4g' },
	'3g': { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400, preset: '3g' },
	offline: { offline: true, latencyMs: 0, preset: 'offline' },
}

/** POST /throttle/net request payload. */
export type NetworkThrottleRequest = { action: 'set'; conditions: NetworkThrottleState } | { action: 'clear' }

/** POST /throttle/net response for the `set` action. */
export type NetworkThrottleSetResponse = Ok<{
	attached: boolean
	applied: boolean
	state: NetworkThrottleState | null
	error?: ErrorDetail | null
}>

/** POST /throttle/net response for the `clear` action. */
export type NetworkThrottleClearResponse = Ok<{
	attached: boolean
	applied: boolean
	state: null
	error?: ErrorDetail | null
}>

/** Schema for POST /throttle/net request payloads. */
export const networkThrottleRequestSchema = defineProtocolSchema<NetworkThrottleRequest>((value) => {
	const invalid = requireObject<NetworkThrottleRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, THROTTLE_ACTIONS),
		conditions: optionalRecord,
	})
	if (!fields.ok) return fields
	const { action, conditions } = fields.value

	if (action == null) {
		return invalidProtocolPayload(`action must be one of: ${THROTTLE_ACTIONS.join(', ')}`)
	}
	if (action === 'clear') {
		return validProtocolPayload({ action })
	}
	if (conditions == null) {
		return invalidProtocolPayload('conditions is required for set action')
	}

	const parsed = readFields(conditions, {
		offline: optionalBoolean,
		latencyMs: (source, key) => optionalNumber(source, key, { min: 0 }),
		downloadKbps: optionalNumber,
		uploadKbps: optionalNumber,
		preset: (source, key) => optionalEnum(source, key, NETWORK_THROTTLE_PRESET_NAMES),
	})
	if (!parsed.ok) return parsed
	const { offline = false, latencyMs = 0, downloadKbps, uploadKbps, preset } = parsed.value

	// A cap of 0 would read as "block everything"; that is what `offline` is for.
	if ((downloadKbps ?? 1) <= 0 || (uploadKbps ?? 1) <= 0) {
		return invalidProtocolPayload('downloadKbps and uploadKbps must be > 0 (omit a cap for unlimited)')
	}

	return validProtocolPayload({ action, conditions: compact({ offline, latencyMs, downloadKbps, uploadKbps, preset }) })
})
