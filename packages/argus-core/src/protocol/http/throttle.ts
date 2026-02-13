/** CPU throttling state. */
export type ThrottleCpuState = {
	/** Throttling rate. 1 = no throttle, 4 = 4x slowdown. Must be >= 1. */
	rate: number
}

/** Network throttling state (matches Chrome DevTools network condition params). */
export type ThrottleNetworkState = {
	/** Whether to emulate offline. */
	offline: boolean
	/** Minimum latency in milliseconds. */
	latency: number
	/** Maximum download throughput in bytes/sec. -1 disables throttling. */
	downloadThroughput: number
	/** Maximum upload throughput in bytes/sec. -1 disables throttling. */
	uploadThroughput: number
}

/** Cache disabled state. */
export type ThrottleCacheState = {
	/** Whether the browser cache is disabled. */
	disabled: boolean
}

/**
 * Desired throttle state sent to the watcher.
 *
 * Each field is independently optional:
 * - Present means "apply this aspect".
 * - `undefined` / missing means "leave unchanged".
 * - On clear, all aspects are reset.
 */
export type ThrottleState = {
	/** CPU throttling. */
	cpu?: ThrottleCpuState
	/** Network condition emulation. */
	network?: ThrottleNetworkState
	/** Browser cache toggle. */
	cache?: ThrottleCacheState
}

/** POST /throttle request payload. */
export type ThrottleRequest = { action: 'set'; state: ThrottleState } | { action: 'clear'; aspects?: ('cpu' | 'network' | 'cache')[] }

/** POST /throttle response for the `set` action. */
export type ThrottleSetResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the throttle state was applied to the current CDP session. */
	applied: boolean
	/** The desired throttle state after the operation. */
	state: ThrottleState | null
	/** Optional error details when `applied` is false due to a CDP failure. */
	error?: { message: string; code?: string } | null
}

/** POST /throttle response for the `clear` action. */
export type ThrottleClearResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the clear was applied. */
	applied: boolean
	/** The remaining throttle state after partial clear, or null after full clear. */
	state: ThrottleState | null
	/** Optional error details when `applied` is false due to a CDP failure. */
	error?: { message: string; code?: string } | null
}

/** GET /throttle response. */
export type ThrottleStatusResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the desired state is currently applied to the attached target. */
	applied: boolean
	/** Current desired throttle state. Null when no throttling is active. */
	state: ThrottleState | null
	/** Last error from a failed apply attempt, if any. */
	lastError?: { message: string; code?: string } | null
}
