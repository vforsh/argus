/**
 * Visibility lock controls whether the attached page should behave as if
 * visible/focused even when the Chrome window is backgrounded or covered.
 *
 * - `shown`: the watcher is actively keeping the page "visible+focused" via
 *   CDP focus emulation (and best-effort window raise on the first apply).
 *   This unthrottles rAF/timers and prevents visibility-hidden stalls in
 *   game/preview boot flows.
 * - `default`: no override. The page honors Chrome's real visibility/focus
 *   state (may throttle when backgrounded).
 */
export type VisibilityLock = 'shown' | 'default'

/** POST /visibility request payload. */
export type VisibilityRequest = {
	/** `show` locks the page shown+focused; `hide` releases the lock. */
	action: 'show' | 'hide'
}

/**
 * Shared response shape for POST /visibility and GET /visibility.
 *
 * - `state` is the desired lock state after the call.
 * - `applied` is true only when the desired state was successfully pushed to
 *   the currently attached CDP session. If the watcher is detached, the
 *   desired state is remembered and re-applied on the next attach.
 */
export type VisibilityResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether the desired state is currently applied to the attached session. */
	applied: boolean
	/** Current desired visibility lock. */
	state: VisibilityLock
	/** Last error from a failed apply attempt (if any). */
	error?: { message: string; code?: string } | null
}
