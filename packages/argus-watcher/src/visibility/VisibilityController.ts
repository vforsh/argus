import type { VisibilityLock } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'

/**
 * Tracks the desired "show" lock and (re)applies it to the attached CDP
 * session. Mirrors EmulationController / ThrottleController: the desired
 * state survives detaches and is re-applied on the next attach, so
 * `argus page show` is sticky until `argus page hide`.
 */
export type VisibilityController = {
	/** Current desired lock (what the next attach would apply). */
	getDesired: () => VisibilityLock
	/** Set the desired lock and apply to `session` now (if attached). Throws on CDP error. */
	setLock: (session: CdpSessionHandle | null, lock: VisibilityLock) => Promise<void>
	/** Called on every (re)attach; re-sends CDP commands when lock is `shown`. */
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/**
 * Implementation notes:
 * - `Page.bringToFront` is best-effort — a one-shot hint that raises the tab
 *   at call time. Failure is swallowed; some environments (headless, minimized
 *   OS windows, extension transport without a focused window) no-op it.
 * - `Emulation.setFocusEmulationEnabled({ enabled: true })` is the mechanism
 *   that keeps the page unthrottled while its window is covered. Session-
 *   scoped, so it must be re-applied after every reattach.
 */
export const createVisibilityController = (): VisibilityController => {
	let desired: VisibilityLock = 'default'

	const apply = async (session: CdpSessionHandle, lock: VisibilityLock): Promise<void> => {
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

	return {
		getDesired: () => desired,
		setLock: async (session, lock) => {
			desired = lock
			if (!session || !session.isAttached()) {
				return
			}
			await apply(session, lock)
		},
		onAttach: async (session) => {
			if (desired !== 'shown') {
				return
			}
			try {
				await apply(session, 'shown')
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				console.warn(`[Visibility] Failed to re-apply on attach: ${message}`)
			}
		},
	}
}
