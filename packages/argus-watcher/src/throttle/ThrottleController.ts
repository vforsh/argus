import type { ThrottleState, ThrottleStatusResponse, ThrottleSetResponse, ThrottleClearResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyThrottle, clearThrottle } from '../cdp/throttle.js'

type ThrottleError = { message: string; code?: string }

export type ThrottleController = {
	getStatus: (ctx: { attached: boolean }) => ThrottleStatusResponse
	setDesired: (state: ThrottleState, session: CdpSessionHandle | null) => Promise<ThrottleSetResponse>
	clearDesired: (aspects: ('cpu' | 'network' | 'cache')[] | undefined, session: CdpSessionHandle | null) => Promise<ThrottleClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

export const createThrottleController = (): ThrottleController => {
	let desired: ThrottleState | null = null
	let applied = false
	let lastError: ThrottleError | null = null

	const isStateEmpty = (state: ThrottleState): boolean => !state.cpu && !state.network && !state.cache

	const getStatus = (ctx: { attached: boolean }): ThrottleStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		applied,
		state: desired,
		lastError,
	})

	const setDesired = async (state: ThrottleState, session: CdpSessionHandle | null): Promise<ThrottleSetResponse> => {
		// Merge incoming state into existing desired (partial updates)
		desired = { ...desired, ...state }
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: desired }
		}

		try {
			await applyThrottle(session, state)
			applied = true
			return { ok: true, attached: true, applied: true, state: desired }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: desired, error: lastError }
		}
	}

	const clearDesired = async (
		aspects: ('cpu' | 'network' | 'cache')[] | undefined,
		session: CdpSessionHandle | null,
	): Promise<ThrottleClearResponse> => {
		lastError = null

		if (!aspects || aspects.length === 0) {
			// Full clear
			desired = null
		} else {
			// Partial clear — remove only specified aspects
			if (desired) {
				for (const aspect of aspects) {
					delete desired[aspect]
				}
				if (isStateEmpty(desired)) {
					desired = null
				}
			}
		}

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: desired }
		}

		try {
			if (!desired) {
				await clearThrottle(session)
			} else {
				// Re-apply the remaining state from scratch after partial clear
				await clearThrottle(session)
				await applyThrottle(session, desired)
			}
			applied = desired !== null
			return { ok: true, attached: true, applied: true, state: desired }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: desired, error: lastError }
		}
	}

	const onAttach = async (session: CdpSessionHandle): Promise<void> => {
		if (!desired) {
			applied = false
			return
		}

		try {
			await applyThrottle(session, desired)
			applied = true
			lastError = null
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			console.warn(`[Throttle] Failed to re-apply throttle on attach: ${lastError.message}`)
		}
	}

	return { getStatus, setDesired, clearDesired, onAttach }
}
