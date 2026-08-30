import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalEnum, optionalNumber, optionalRecord, readFields, requireObject } from '../schemaFields.js'

/** Viewport emulation parameters for device metrics override. */
export type EmulationViewport = {
	/** Viewport width in CSS pixels. Must be a positive integer. */
	width: number
	/** Viewport height in CSS pixels. Must be a positive integer. */
	height: number
	/** Device scale factor (DPR). Must be a finite number greater than 0. */
	deviceScaleFactor: number
	/** Whether to emulate a mobile device. */
	mobile: boolean
}

/**
 * Desired emulation state sent to the watcher.
 *
 * Each field is independently optional:
 * - `null` means "reset this aspect to default".
 * - `undefined` / missing means "leave unchanged" (only meaningful for partial updates; on first set, missing = default).
 */
export type EmulationState = {
	/** Viewport dimensions, DPR, and mobile flag. Null clears device metrics override. */
	viewport?: EmulationViewport | null
	/** Touch emulation toggle. Null disables touch emulation. */
	touch?: { enabled: boolean } | null
	/**
	 * User-agent override.
	 * - `{ value: "<string>" }` sets the override.
	 * - `{ value: null }` restores the baseline (pre-emulation) user-agent.
	 * - `null` / missing leaves unchanged on partial update; on clear restores baseline.
	 */
	userAgent?: { value: string | null } | null
}

/** POST /emulation request payload (action-based, like /storage/local). */
export type EmulationRequest = { action: 'set'; state: EmulationState } | { action: 'clear' }

/** POST /emulation response for the `set` action. */
export type EmulationSetResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the emulation state was applied to the current CDP session. False if queued (detached) or apply failed. */
	applied: boolean
	/** The desired emulation state after the operation. */
	state: EmulationState | null
	/** Optional error details when `applied` is false due to a CDP failure. */
	error?: { message: string; code?: string } | null
}

/** POST /emulation response for the `clear` action. */
export type EmulationClearResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the clear was applied (metrics + touch + UA restored). */
	applied: boolean
	/** Always null after clear. */
	state: null
	/** Optional error details when `applied` is false due to a CDP failure. */
	error?: { message: string; code?: string } | null
}

/** GET /emulation response. */
export type EmulationStatusResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the desired state is currently applied to the attached target. */
	applied: boolean
	/** Current desired emulation state. Null when no emulation is active. */
	state: EmulationState | null
	/** Best-effort baseline values captured on attach. `userAgent` is null when detached or not yet resolved. */
	baseline: { userAgent: string | null }
	/** Last error from a failed apply attempt, if any. */
	lastError?: { message: string; code?: string } | null
}

/** Actions accepted by POST /emulation. */
export const EMULATION_ACTIONS = ['set', 'clear'] as const

/** Schema for POST /emulation request payloads. */
export const emulationRequestSchema = defineProtocolSchema<EmulationRequest>((value) => {
	const invalid = requireObject<EmulationRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, EMULATION_ACTIONS),
		state: optionalRecord,
	})
	if (!fields.ok) return fields
	const { action, state } = fields.value

	if (action == null) {
		return invalidProtocolPayload(`action must be one of: ${EMULATION_ACTIONS.join(', ')}`)
	}
	if (action === 'clear') {
		return validProtocolPayload({ action })
	}
	if (state == null) {
		return invalidProtocolPayload('state is required for set action')
	}

	const parsed = parseEmulationState(state)
	if (typeof parsed === 'string') {
		return invalidProtocolPayload(parsed)
	}

	return validProtocolPayload({ action, state: parsed })
})

/**
 * Validate the nested emulation state.
 *
 * Each aspect is independently optional and `null` means "reset this one", so absence and
 * an explicit null are not interchangeable — hence the explicit `!= null` checks rather
 * than the flat readers used elsewhere.
 *
 * @returns The parsed state, or an error message.
 */
const parseEmulationState = (state: Record<string, unknown>): EmulationState | string => {
	const result: EmulationState = {}

	if (state.viewport !== undefined) {
		if (state.viewport === null) {
			result.viewport = null
		} else {
			const viewport = readFields(state, { viewport: optionalRecord })
			if (!viewport.ok || viewport.value.viewport == null) {
				return 'viewport must be an object or null'
			}
			const vp = viewport.value.viewport
			const parsed = readFields(vp, {
				width: (source, key) => optionalNumber(source, key, { min: 1 }),
				height: (source, key) => optionalNumber(source, key, { min: 1 }),
				deviceScaleFactor: (source, key) => optionalNumber(source, key, { min: Number.EPSILON }),
				mobile: optionalBoolean,
			})
			if (!parsed.ok) {
				return 'viewport fields must be positive numbers with a boolean mobile flag'
			}
			const { width, height, deviceScaleFactor, mobile } = parsed.value
			if (width == null || !Number.isInteger(width)) return 'viewport.width must be a positive integer'
			if (height == null || !Number.isInteger(height)) return 'viewport.height must be a positive integer'
			if (deviceScaleFactor == null) return 'viewport.deviceScaleFactor must be a finite number > 0'
			if (mobile == null) return 'viewport.mobile must be a boolean'
			result.viewport = { width, height, deviceScaleFactor, mobile }
		}
	}

	if (state.touch !== undefined) {
		if (state.touch === null) {
			result.touch = null
		} else {
			const touch = state.touch as Record<string, unknown>
			if (typeof touch?.enabled !== 'boolean') {
				return 'touch.enabled must be a boolean'
			}
			result.touch = { enabled: touch.enabled }
		}
	}

	if (state.userAgent !== undefined) {
		if (state.userAgent === null) {
			result.userAgent = null
		} else {
			const ua = state.userAgent as Record<string, unknown>
			if (ua?.value !== null && (typeof ua?.value !== 'string' || ua.value === '')) {
				return 'userAgent.value must be a non-empty string or null'
			}
			result.userAgent = { value: ua.value as string | null }
		}
	}

	return compact(result)
}
