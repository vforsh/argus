import type { VisibilityLock, VisibilityPolicy } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { createStickyController } from '../stickyController.js'

/**
 * Tracks the desired "show" lock and (re)applies it to the attached CDP session, so
 * `argus page show` is sticky until `argus page hide`.
 *
 * Implementation notes:
 * - `Page.bringToFront` is foreground-only and best-effort — a one-shot hint that raises the tab at call time.
 *   Failure is swallowed; some environments (headless, minimized OS windows, extension
 *   transport without a focused window) no-op it.
 * - `Emulation.setFocusEmulationEnabled({ enabled: true })` is the mechanism that keeps
 *   the page unthrottled while its window is covered. Session-scoped, so it must be
 *   re-applied after every reattach.
 */
export type VisibilityController = {
	/** Current desired lock (what the next attach would apply). */
	getDesired: () => VisibilityLock
	/** Activation policy retained across lock changes and reattachment. */
	getPolicy: () => VisibilityPolicy
	/** Set the desired lock and apply to `session` now (if attached). Throws on CDP error. `activate: false` suppresses raising only for this call. */
	setLock: (session: CdpSessionHandle | null, lock: VisibilityLock, policy?: VisibilityPolicy, activate?: boolean) => Promise<void>
	/** Called on every (re)attach; re-sends CDP commands when lock is `shown`. */
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/** Build a visibility controller with a foreground policy until explicitly changed. */
export const createVisibilityController = (): VisibilityController => {
	let policy: VisibilityPolicy = 'foreground'
	const sticky = createStickyController<VisibilityLock>({
		label: 'Visibility',
		apply: async (session, state) => {
			await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: state === 'shown' })
		},
		// Releasing the lock is the same operation as locking to `default`.
		clear: async (session) => {
			await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: false })
		},
	})

	return {
		// `default` rather than null: visibility has no "unset", only "not locked shown".
		getDesired: () => sticky.getState().state ?? 'default',
		getPolicy: () => policy,
		setLock: async (session, lock, nextPolicy = policy, activate = true) => {
			policy = nextPolicy
			if (lock === 'shown' && policy === 'foreground' && activate && session?.isAttached()) {
				await bringToFront(session)
			}
			const result = await sticky.setDesired(lock, session)
			// This controller reports CDP failure by throwing, unlike its two siblings.
			if (result.lastError) {
				throw new Error(result.lastError.message)
			}
		},
		onAttach: async (session) => {
			if (sticky.getState().state !== 'shown') {
				return
			}
			if (policy === 'foreground') await bringToFront(session)
			await sticky.onAttach(session)
		},
	}
}

const bringToFront = async (session: CdpSessionHandle): Promise<void> => {
	try {
		await session.sendAndWait('Page.bringToFront')
	} catch {
		// Advisory — focus emulation carries the weight.
	}
}
