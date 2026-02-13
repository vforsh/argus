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
export type ThrottleSetResponse = {
	ok: true
	attached: boolean
	applied: boolean
	state: ThrottleState | null
	error?: { message: string; code?: string } | null
}

/** POST /throttle response for the `clear` action. */
export type ThrottleClearResponse = {
	ok: true
	attached: boolean
	applied: boolean
	state: null
	error?: { message: string; code?: string } | null
}

/** GET /throttle response. */
export type ThrottleStatusResponse = {
	ok: true
	attached: boolean
	applied: boolean
	state: ThrottleState | null
	lastError?: { message: string; code?: string } | null
}
