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
