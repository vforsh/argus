/**
 * Visibility lock controls whether the attached page should behave as if
 * visible/focused even when the Chrome window is backgrounded or covered.
 *
 * - `shown`: the watcher is actively keeping the page "visible+focused" via
 *   CDP focus emulation (and best-effort window raise on each apply).
 *   Unthrottles rAF/timers and prevents visibility-hidden stalls in
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
 * POST /visibility response. Desired lock is sticky across detach/reattach —
 * it is remembered by the watcher and re-applied on the next attach when
 * `attached` is `false`.
 */
export type VisibilityResponse = {
	ok: true
	/** Whether the watcher was attached to a CDP target at response time. */
	attached: boolean
	/** Current desired visibility lock. */
	state: VisibilityLock
}
