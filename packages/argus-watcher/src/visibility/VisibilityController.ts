import type { VisibilityLock } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { createStickyController } from '../stickyController.js'

/**
 * Tracks the desired "show" lock and (re)applies it to the attached CDP session, so
 * `argus page show` is sticky until `argus page hide`.
 *
 * Implementation notes:
 * - `Page.bringToFront` is best-effort — a one-shot hint that raises the tab at call time.
 *   Failure is swallowed; some environments (headless, minimized OS windows, extension
 *   transport without a focused window) no-op it.
 * - `Emulation.setFocusEmulationEnabled({ enabled: true })` is the mechanism that keeps
 *   the page unthrottled while its window is covered. Session-scoped, so it must be
 *   re-applied after every reattach.
 */
export type VisibilityController = {
	/** Current desired lock (what the next attach would apply). */
	getDesired: () => VisibilityLock
	/** Set the desired lock and apply to `session` now (if attached). Throws on CDP error. */
	setLock: (session: CdpSessionHandle | null, lock: VisibilityLock) => Promise<void>
	/** Called on every (re)attach; re-sends CDP commands when lock is `shown`. */
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

const applyLock = async (session: CdpSessionHandle, lock: VisibilityLock): Promise<void> => {
	if (lock !== 'shown') {
		await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: false })
		return
	}

	try {
		await session.sendAndWait('Page.bringToFront')
	} catch {
		// Advisory — focus emulation below carries the weight.
	}
	await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: true })
}

export const createVisibilityController = (): VisibilityController => {
	const sticky = createStickyController<VisibilityLock>({
		label: 'Visibility',
		apply: applyLock,
		// Releasing the lock is the same operation as locking to `default`.
		clear: (session) => applyLock(session, 'default'),
	})

	return {
		// `default` rather than null: visibility has no "unset", only "not locked shown".
		getDesired: () => sticky.getState().state ?? 'default',
		setLock: async (session, lock) => {
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
			await sticky.onAttach(session)
		},
	}
}
