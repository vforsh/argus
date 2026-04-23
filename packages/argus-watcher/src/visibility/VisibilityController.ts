import type { VisibilityLock, VisibilityResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'

type VisibilityError = { message: string; code?: string }

/**
 * Tracks the desired "show" lock and (re)applies it to the attached CDP
 * session. Mirrors the EmulationController pattern: state survives detaches
 * and is re-applied on the next attach so `argus page show` is effectively
 * sticky until an explicit `argus page hide`.
 */
export type VisibilityController = {
	getResponse: (ctx: { attached: boolean }) => VisibilityResponse
	show: (session: CdpSessionHandle | null) => Promise<VisibilityResponse>
	hide: (session: CdpSessionHandle | null) => Promise<VisibilityResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/**
 * Create a controller that manages page visibility locking.
 *
 * Implementation notes:
 * - `Page.bringToFront` is best-effort — it's a one-shot hint that raises the
 *   tab/window at call time. We call it on `show` and on re-apply, but we do
 *   not treat failure as fatal; some environments (headless, minimized OS
 *   windows, extension transport without a focused window) can no-op it.
 * - `Emulation.setFocusEmulationEnabled({ enabled: true })` is the actual
 *   mechanism that keeps the page unthrottled even when its window is
 *   covered. It's idempotent and session-scoped, so it survives navigations
 *   within the same target but must be re-applied after reattach.
 */
export const createVisibilityController = (): VisibilityController => {
	let desired: VisibilityLock = 'default'
	let applied = false
	let lastError: VisibilityError | null = null

	const apply = async (session: CdpSessionHandle, lock: VisibilityLock): Promise<void> => {
		if (lock === 'shown') {
			// bringToFront is advisory; don't let it mask the focus-emulation failure below.
			try {
				await session.sendAndWait('Page.bringToFront')
			} catch {
				// Swallow — focus emulation carries the weight.
			}
			await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: true })
			return
		}

		await session.sendAndWait('Emulation.setFocusEmulationEnabled', { enabled: false })
	}

	const transition = async (session: CdpSessionHandle | null, next: VisibilityLock): Promise<VisibilityResponse> => {
		desired = next
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: desired, error: null }
		}

		try {
			await apply(session, next)
			applied = true
			return { ok: true, attached: true, applied: true, state: desired, error: null }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: desired, error: lastError }
		}
	}

	return {
		getResponse: (ctx) => ({
			ok: true,
			attached: ctx.attached,
			applied: ctx.attached && applied,
			state: desired,
			error: lastError,
		}),
		show: (session) => transition(session, 'shown'),
		hide: (session) => transition(session, 'default'),
		onAttach: async (session) => {
			if (desired !== 'shown') {
				applied = false
				return
			}

			try {
				await apply(session, 'shown')
				applied = true
				lastError = null
			} catch (error) {
				applied = false
				lastError = { message: error instanceof Error ? error.message : String(error) }
				console.warn(`[Visibility] Failed to re-apply on attach: ${lastError.message}`)
			}
		},
	}
}
