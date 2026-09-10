import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalEnum, readFields, requireObject } from '../schemaFields.js'
import type { Ok } from './errors.js'

/**
 * Visibility lock controls whether the attached page should behave as if
 * visible/focused even when the Chrome window is backgrounded or covered.
 *
 * - `shown`: the watcher is actively keeping the page "visible+focused" via
 *   CDP focus emulation. Foreground policy may also best-effort raise the window on apply.
 *   Unthrottles rAF/timers and prevents visibility-hidden stalls in
 *   game/preview boot flows.
 * - `default`: no override. The page honors Chrome's real visibility/focus
 *   state (may throttle when backgrounded).
 */
export type VisibilityLock = 'shown' | 'default'

/** How a shown lock keeps the page running. `background` never activates the tab/window. */
export type VisibilityPolicy = 'foreground' | 'background'

/** POST /visibility request payload. */
export type VisibilityRequest = {
	/** `show` locks the page shown+focused; `hide` releases the lock. */
	action: 'show' | 'hide'
	/** Whether a shown lock may activate the browser tab/window. Omit to preserve the current policy. */
	policy?: VisibilityPolicy
	/** Suppress one-shot foreground activation while applying the requested lock. */
	activate?: boolean
}

/**
 * POST /visibility response. Desired lock is sticky across detach/reattach —
 * it is remembered by the watcher and re-applied on the next attach when
 * `attached` is `false`.
 */
export type VisibilityResponse = Ok<{
	/** Whether the watcher was attached to a CDP target at response time. */
	attached: boolean
	/** Current desired visibility lock. */
	state: VisibilityLock
	/** Current desired policy used when applying a shown lock. */
	policy: VisibilityPolicy
}>

/** Actions accepted by POST /visibility. */
export const VISIBILITY_ACTIONS = ['show', 'hide'] as const

/** Visibility policies accepted by POST /visibility. */
export const VISIBILITY_POLICIES = ['foreground', 'background'] as const

/** Schema for POST /visibility request payloads. */
export const visibilityRequestSchema = defineProtocolSchema<VisibilityRequest>((value) => {
	const invalid = requireObject<VisibilityRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, VISIBILITY_ACTIONS),
		policy: (source, key) => optionalEnum(source, key, VISIBILITY_POLICIES),
		activate: optionalBoolean,
	})
	if (!fields.ok) return fields

	if (fields.value.action == null) {
		return invalidProtocolPayload('Visibility action must be "show" or "hide"')
	}

	return validProtocolPayload(
		compact({
			action: fields.value.action,
			policy: fields.value.policy,
			activate: fields.value.activate,
		}),
	)
})
