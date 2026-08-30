import type { ThrottleState, ThrottleStatusResponse, ThrottleSetResponse, ThrottleClearResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyThrottle, clearThrottle } from '../cdp/throttle.js'
import { createStickyController } from '../stickyController.js'

export type ThrottleController = {
	getStatus: (ctx: { attached: boolean }) => ThrottleStatusResponse
	setDesired: (rate: number, session: CdpSessionHandle | null) => Promise<ThrottleSetResponse>
	clearDesired: (session: CdpSessionHandle | null) => Promise<ThrottleClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/** Desired CPU throttle rate, re-applied on every attach until cleared. */
export const createThrottleController = (): ThrottleController => {
	const sticky = createStickyController<ThrottleState>({
		label: 'Throttle',
		apply: (session, state) => applyThrottle(session, state.rate),
		clear: (session) => clearThrottle(session),
	})

	return {
		getStatus: (ctx) => {
			const { applied, state, lastError } = sticky.getState()
			return { ok: true, attached: ctx.attached, applied, state, lastError }
		},
		setDesired: async (rate, session) => {
			const { attached, applied, state, lastError } = await sticky.setDesired({ rate }, session)
			return { ok: true, attached, applied, state, ...(lastError ? { error: lastError } : {}) }
		},
		clearDesired: async (session) => {
			const { attached, applied, lastError } = await sticky.clearDesired(session)
			return { ok: true, attached, applied, state: null, ...(lastError ? { error: lastError } : {}) }
		},
		onAttach: sticky.onAttach,
	}
}
